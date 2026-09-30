import { parseArgs } from 'node:util';

import { discoverProject, openStateStore, registerProject } from '../../projects/index.ts';
import type { LoadedProject, ProjectRecord } from '../../projects/index.ts';
import { MILESTONE_STATUSES } from '../../state/index.ts';
import type { ProjectState } from '../../state/index.ts';
import { commitEligibility, deriveWorkflow } from '../../tasks/index.ts';
import type { ExecutorLiveness, TaskCondition, WorkflowView } from '../../tasks/index.ts';
import { ValidationProfileStore } from '../../validation/index.ts';
import type { ValidationProfile } from '../../validation/index.ts';
import { countConditions } from '../workflow-format.ts';
import { createRunner, requireConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

const USAGE = [
  'forge project <subcommand>',
  '',
  'Subcommands:',
  '  add <path> [--name <name>] [--description <text>]',
  '                 Register a Git work tree root as a Forge project',
  '  show           Show the project containing the current directory',
  '  status         Show the persisted state of that project',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  add: runAdd,
  show: runShow,
  status: runStatus,
};

export const projectCommand: CliCommand = {
  name: 'project',
  summary: 'Register and inspect Forge projects',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge project: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    return subcommand(rest, context);
  },
};

async function runAdd(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const parsed = parseSubcommandArgs('add', args, context, {
    name: { type: 'string' },
    description: { type: 'string' },
  });
  if (parsed === undefined) {
    return ExitCode.Usage;
  }
  const [path, ...extra] = parsed.positionals;
  if (path === undefined || extra.length > 0) {
    context.stderr.write(`forge project add: expected exactly one <path>\n`);
    return ExitCode.Usage;
  }

  const name = parsed.values['name'];
  const description = parsed.values['description'];
  const registered = await registerProject({
    path,
    cwd: context.cwd,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    // Project commands need valid configuration; a ConfigurationError surfaces as a failure.
    runner: createRunner(context, requireConfig(context)),
    logger: context.logger.child('projects'),
  });

  context.stdout.write(
    `Registered project "${registered.project.name}"\n${formatProject(registered.project, registered.layout.forgeDir)}`,
  );
  return ExitCode.Success;
}

async function runShow(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const loaded = await requireProject('show', args, context);
  if (typeof loaded === 'number') {
    return loaded;
  }
  context.stdout.write(formatProject(loaded.project, loaded.layout.forgeDir));
  return ExitCode.Success;
}

async function runStatus(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const loaded = await requireProject('status', args, context);
  if (typeof loaded === 'number') {
    return loaded;
  }
  const state = await openStateStore(loaded).load();
  const validation = await new ValidationProfileStore(loaded.layout).load().catch(() => undefined);
  context.stdout.write(formatStatus(loaded.project, state, undefined, validation));
  return ExitCode.Success;
}

/** Resolves the project containing the working directory, or returns an exit code. */
async function requireProject(
  subcommand: string,
  args: readonly string[],
  context: CliContext,
): Promise<LoadedProject | ExitCodeValue> {
  const parsed = parseSubcommandArgs(subcommand, args, context, {});
  if (parsed === undefined) {
    return ExitCode.Usage;
  }
  if (parsed.positionals.length > 0) {
    context.stderr.write(`forge project ${subcommand}: unexpected argument "${parsed.positionals[0]}"\n`);
    return ExitCode.Usage;
  }
  const loaded = await discoverProject(context.cwd);
  if (loaded === undefined) {
    context.stderr.write(
      `forge project ${subcommand}: no Forge project found at or above ${context.cwd}\n` +
        'Register one with: forge project add <path>\n',
    );
    return ExitCode.Failure;
  }
  return loaded;
}

type StringOptions = Record<string, { type: 'string' }>;

function parseSubcommandArgs(
  subcommand: string,
  args: readonly string[],
  context: CliContext,
  options: StringOptions,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } | undefined {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.stderr.write(`forge project ${subcommand}: ${message}\n`);
    return undefined;
  }
}

export function formatProject(project: ProjectRecord, forgeDir: string): string {
  return formatFields([
    ['Name', project.name],
    ['ID', project.id],
    ['Status', project.status],
    ['Root', project.rootPath],
    ['Metadata', forgeDir],
    ['Description', project.description ?? '(none)'],
    ['Schema', `v${project.schemaVersion}`],
    ['Created', project.createdAt],
    ['Updated', project.updatedAt],
  ]);
}

export function formatStatus(
  project: ProjectRecord,
  state: ProjectState,
  liveness?: ExecutorLiveness,
  validation?: ValidationProfile,
): string {
  const view = deriveWorkflow(state, liveness);
  const pendingDecisions = state.decisions.filter((decision) => decision.status === 'pending').length;
  const count = (condition: TaskCondition): number => view.tasks.filter((task) => task.condition === condition).length;
  const attention = [
    count('awaiting-validation') > 0 ? `${count('awaiting-validation')} awaiting validation` : undefined,
    count('interrupted') > 0 ? `${count('interrupted')} interrupted (recovery required)` : undefined,
    count('retryable') > 0 ? `${count('retryable')} failed but retryable` : undefined,
    count('exhausted') > 0 ? `${count('exhausted')} failed with no attempts left` : undefined,
    count('blocked') > 0 ? `${count('blocked')} blocked` : undefined,
    pendingDecisions > 0 ? `${pendingDecisions} decision(s) pending` : undefined,
  ].filter((item) => item !== undefined);
  return formatFields([
    ['Project', `${project.name} (${project.id})`],
    ['Status', project.status],
    ['Phase', state.phase],
    ['Milestones', formatMilestoneCounts(state)],
    ['Tasks', countConditions(view.tasks)],
    ['Runnable', view.runnable.length === 0 ? '0' : `${view.runnable.length} (${view.runnable.map((task) => task.key).join(', ')})`],
    ['Attention', attention.length === 0 ? 'none' : attention.join('; ')],
    ['Validation', formatValidationSummary(validation)],
    ['Uncommitted', formatUncommitted(view)],
    ['Worker runs', formatWorkerRuns(state)],
    ['Revision', String(state.revision)],
    ['Updated', state.updatedAt],
  ]);
}

function formatValidationSummary(profile: ValidationProfile | undefined): string {
  if (profile === undefined) {
    return 'unknown';
  }
  const required = profile.checks.filter((check) => check.required).length;
  return profile.checks.length === 0
    ? 'no checks configured (tasks will wait for validation)'
    : `${profile.checks.length} check(s), ${required} required (${profile.checks.map((check) => check.id).join(', ')})`;
}

/** Succeeded tasks whose attributed changes Forge has not committed. */
function formatUncommitted(view: WorkflowView): string {
  const pending = view.tasks.filter((task) => task.task.status === 'succeeded' && task.lastAttempt?.changes != null && task.lastAttempt.commit === null && task.lastAttempt.changes.files.length > 0);
  if (pending.length === 0) {
    return 'none';
  }
  return pending
    .map((task) => {
      const eligibility = commitEligibility(task.lastAttempt);
      return `${task.key} (${eligibility.ok ? 'committable' : 'commit refused'})`;
    })
    .join(', ');
}

function formatMilestoneCounts(state: ProjectState): string {
  if (state.milestones.length === 0) {
    return '0';
  }
  const parts = MILESTONE_STATUSES.map((status) => [status, state.milestones.filter((milestone) => milestone.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`);
  return `${state.milestones.length} (${parts.join(', ')})`;
}

function formatWorkerRuns(state: ProjectState): string {
  const last = state.workerRuns.at(-1);
  if (last === undefined) {
    return '0';
  }
  return `${state.workerRuns.length} (last: ${last.worker} ${last.status} at ${last.startedAt})`;
}

function formatFields(fields: readonly (readonly [string, string])[]): string {
  const width = Math.max(...fields.map(([label]) => label.length)) + 1;
  return `${fields.map(([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`).join('\n')}\n`;
}
