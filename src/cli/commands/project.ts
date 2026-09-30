import { parseArgs } from 'node:util';

import { discoverProject, openStateStore, registerProject } from '../../projects/index.ts';
import type { LoadedProject, ProjectRecord } from '../../projects/index.ts';
import { TASK_STATUSES } from '../../state/index.ts';
import type { ProjectState } from '../../state/index.ts';
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
  context.stdout.write(formatStatus(loaded.project, state));
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

export function formatStatus(project: ProjectRecord, state: ProjectState): string {
  const pendingDecisions = state.decisions.filter((decision) => decision.status === 'pending').length;
  const milestonesDone = state.milestones.filter((milestone) => milestone.status === 'completed').length;
  return formatFields([
    ['Project', `${project.name} (${project.id})`],
    ['Status', project.status],
    ['Phase', state.phase],
    ['Milestones', `${state.milestones.length} total, ${milestonesDone} completed`],
    ['Tasks', formatTaskCounts(state)],
    ['Decisions', pendingDecisions === 0 ? 'none pending' : `${pendingDecisions} pending — human input required`],
    ['Worker runs', formatWorkerRuns(state)],
    ['Revision', String(state.revision)],
    ['Updated', state.updatedAt],
  ]);
}

function formatWorkerRuns(state: ProjectState): string {
  const last = state.workerRuns.at(-1);
  if (last === undefined) {
    return '0';
  }
  return `${state.workerRuns.length} (last: ${last.worker} ${last.status} at ${last.startedAt})`;
}

function formatTaskCounts(state: ProjectState): string {
  if (state.tasks.length === 0) {
    return '0';
  }
  const counts = TASK_STATUSES.map((status) => [status, state.tasks.filter((task) => task.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`);
  return `${state.tasks.length} (${counts.join(', ')})`;
}

function formatFields(fields: readonly (readonly [string, string])[]): string {
  const width = Math.max(...fields.map(([label]) => label.length)) + 1;
  return `${fields.map(([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`).join('\n')}\n`;
}
