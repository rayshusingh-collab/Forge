import { TaskEngine, resolveTaskReference } from '../../tasks/index.ts';
import type { TaskRunOutcome, TaskView, WorkflowView } from '../../tasks/index.ts';
import type { Worker } from '../../workers/index.ts';
import { booleanOption, expectPositionals, listOption, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { roleProvider } from '../../control/index.ts';
import { createRunner, lenientConfig, loadProjectSettings, requireConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { formatChanges, formatReady, formatTask, formatTaskTable } from '../workflow-format.ts';
import { formatValidation } from './validation.ts';
import { reviewCommand, reviewDecisionCommand, reviewShowCommand } from './task-review.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { MAX_TIMEOUT_SECONDS, createWorker, formatIntegrityViolation, parseTimeoutSeconds } from './worker.ts';

const USAGE = [
  'forge task <subcommand>',
  '',
  'Subcommands:',
  '  add --milestone <m> --title <text> --instruction <text>',
  '      [--context <text>] [--depends-on <task>]... [--max-attempts <n>]',
  '                                  Add a task (repeat --depends-on, or separate with commas)',
  '  list [--milestone <m>]          List tasks in order with their condition',
  '  show <task>                     Show a task, its dependencies, and its attempts',
  '  ready                           List tasks that can run now',
  '  run <task> [--worker <name>] [--timeout <seconds>] [--allow-edits]',
  '      [--acknowledge-integrity-violation]',
  '                                  Execute ONE attempt of ONE task, validate it, then stop',
  '  validate <task>                 Re-run deterministic validation for a task awaiting validation',
  '  override <task> --reason <text> Accept a task awaiting validation WITHOUT validation (audited)',
  '  reject <task> --reason <text>   Reject a task awaiting validation',
  '  commit <task>                   Commit a validated task\'s own changes locally (never pushes)',
  '  cancel <task> [--reason <text>] Cancel a pending or failed task',
  '  recover <task> [--force]        Mark an interrupted execution as failed',
  '  review <task> [--reviewer <name>] [--timeout <seconds>]',
  '                                  Ask an AI reviewer for an ADVISORY review of a validated task',
  '  review-show <task>              Show the task\'s reviews and decisions',
  '  review-accept <task> --reason <text>',
  '                                  Record: implementation accepted despite the review',
  '  review-reject <task> --reason <text>',
  '                                  Record: remediation required (reopens the task; nothing starts)',
  '',
  '<task> is its key (e.g. 1.2 = milestone 1, task 2), full ID, or a unique ID prefix.',
  'Worker output is a claim; validation is evidence; Forge decides the task status.',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext, engine: TaskEngine, project: LoadedProject) => Promise<ExitCodeValue>;

/** AI review commands (advisory evidence; see task-review.ts). */
const REVIEW_SUBCOMMANDS: Readonly<Record<string, (args: readonly string[], context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>>> = {
  review: reviewCommand,
  'review-show': reviewShowCommand,
  'review-accept': (args, context, project) => reviewDecisionCommand('accepted', args, context, project),
  'review-reject': (args, context, project) => reviewDecisionCommand('remediation-required', args, context, project),
};

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  add,
  list,
  show,
  ready,
  run,
  validate,
  override,
  accept,
  reject,
  commit,
  cancel,
  recover,
};

export const taskCommand: CliCommand = {
  name: 'task',
  summary: 'Create, inspect, and manually execute tasks',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const reviewSubcommand = name === undefined ? undefined : REVIEW_SUBCOMMANDS[name];
    if (reviewSubcommand !== undefined) {
      const project = await requireProject(`task ${name}`, context);
      return typeof project === 'number' ? project : reviewSubcommand(rest, context, project);
    }
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge task: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`task ${name}`, context);
    if (typeof project === 'number') {
      return project;
    }
    const engine = new TaskEngine({ project, runner: createRunner(context, lenientConfig(context)) });
    return subcommand(rest, context, engine, project);
  },
};

async function add(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task add', args, context, {
    milestone: { type: 'string' },
    title: { type: 'string' },
    instruction: { type: 'string' },
    context: { type: 'string' },
    'depends-on': { type: 'string', multiple: true },
    'max-attempts': { type: 'string' },
  });
  if (parsed === undefined || expectPositionals('task add', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const milestone = stringOption(parsed, 'milestone');
  const title = stringOption(parsed, 'title');
  const instruction = stringOption(parsed, 'instruction');
  const missing = [
    milestone === undefined ? '--milestone' : undefined,
    title === undefined ? '--title' : undefined,
    instruction === undefined ? '--instruction' : undefined,
  ].filter((item) => item !== undefined);
  if (missing.length > 0) {
    context.stderr.write(`forge task add: missing ${missing.join(', ')}\n`);
    return ExitCode.Usage;
  }
  const maxAttemptsText = stringOption(parsed, 'max-attempts');
  if (maxAttemptsText !== undefined && !/^\d{1,2}$/.test(maxAttemptsText.trim())) {
    context.stderr.write('forge task add: --max-attempts must be a whole number\n');
    return ExitCode.Usage;
  }

  const task = await engine.addTask({
    milestone: milestone!,
    title: title!,
    instruction: instruction!,
    context: stringOption(parsed, 'context') ?? null,
    dependsOn: listOption(parsed, 'depends-on'),
    ...(maxAttemptsText === undefined ? {} : { maxAttempts: Number(maxAttemptsText.trim()) }),
  });
  const view = (await engine.view()).task(task.id)!;
  context.stdout.write(`Added task ${view.key}: ${task.title} (${task.id}) — ${view.condition}\n`);
  return ExitCode.Success;
}

async function list(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task list', args, context, { milestone: { type: 'string' } });
  if (parsed === undefined || expectPositionals('task list', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const view = await engine.view();
  const milestone = stringOption(parsed, 'milestone');
  const milestoneId = milestone === undefined ? undefined : await engine.resolveMilestone(milestone);
  const tasks = milestoneId === undefined ? view.tasks : view.tasks.filter((task) => task.milestone.id === milestoneId);
  context.stdout.write(formatTaskTable(tasks, view));
  return ExitCode.Success;
}

async function show(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const reference = singleReference('task show', args, context);
  if (reference === undefined) {
    return ExitCode.Usage;
  }
  const state = await engine.load();
  const view = await engine.view();
  context.stdout.write(formatTask(view.task(resolveTaskReference(state, reference))!, view, state));
  return ExitCode.Success;
}

async function ready(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task ready', args, context, {});
  if (parsed === undefined || expectPositionals('task ready', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  context.stdout.write(formatReady(await engine.view()));
  return ExitCode.Success;
}

async function run(args: readonly string[], context: CliContext, engine: TaskEngine, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task run', args, context, {
    worker: { type: 'string' },
    timeout: { type: 'string' },
    'allow-edits': { type: 'boolean' },
    'acknowledge-integrity-violation': { type: 'boolean' },
  });
  const positionals = parsed === undefined ? undefined : expectPositionals('task run', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const timeoutSeconds = parseTimeoutSeconds(stringOption(parsed, 'timeout'));
  if (timeoutSeconds === 'invalid') {
    context.stderr.write(`forge task run: --timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}\n`);
    return ExitCode.Usage;
  }
  const config = requireConfig(context);
  const worker = createWorker(roleProvider('implementer', (await loadProjectSettings(project)).settings, stringOption(parsed, 'worker')).name, context);
  if (worker === undefined) {
    return ExitCode.Usage;
  }
  const access = booleanOption(parsed, 'allow-edits') ? 'edit' : 'read-only';
  const timeoutMs = timeoutSeconds === undefined ? config.workerTimeoutMs : timeoutSeconds * 1000;

  // Validate before announcing anything; the engine checks again atomically when starting.
  const before = (await engine.view()).task(await engine.resolveTask(positionals[0]!))!;
  context.stderr.write(formatTaskBanner(worker, before, project.project.name, access, timeoutMs));

  const outcome = await engine.runTask(before.task.id, {
    worker,
    access,
    timeoutMs,
    acknowledgeIntegrityViolation: booleanOption(parsed, 'acknowledge-integrity-violation'),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  if (!outcome.run.integrity.ok) {
    context.stderr.write(formatIntegrityViolation(outcome.run));
  }
  if (outcome.run.persistenceError !== undefined) {
    context.stdout.write(formatRunReport(outcome, before, await engine.view()));
    context.stderr.write(
      `forge task run: the outcome was NOT recorded: ${outcome.run.persistenceError.message}\n` +
        `The task stays recorded as running; once you have inspected the project, run: forge task recover ${before.key}\n`,
    );
    return ExitCode.Failure;
  }
  context.stdout.write(formatRunReport(outcome, before, await engine.view()));
  // 0 when the task succeeded or is awaiting validation; 1 when it failed.
  return outcome.task?.task.status === 'failed' ? ExitCode.Failure : ExitCode.Success;
}

async function validate(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const reference = singleReference('task validate', args, context);
  if (reference === undefined) {
    return ExitCode.Usage;
  }
  const outcome = await engine.validateTask(reference, context.signal === undefined ? {} : { signal: context.signal });
  const lines: string[] = [];
  if (outcome.post.validation !== null) {
    lines.push('Validation:', formatValidation(outcome.post.validation).trimEnd());
  }
  lines.push(`Forge decision: ${decisionLabel(outcome.task)}`);
  if (outcome.post.note !== null) {
    lines.push(`Reason: ${outcome.post.note}`);
  }
  lines.push(await newlyRunnable(engine));
  context.stdout.write(`${lines.join('\n')}\n`);
  return outcome.task?.task.status === 'failed' ? ExitCode.Failure : ExitCode.Success;
}

async function override(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task override', args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task override', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write('forge task override: --reason <text> is required; overrides are recorded\n');
    return ExitCode.Usage;
  }
  await engine.overrideTask(positionals[0]!, reason);
  context.stdout.write(
    `Task ${positionals[0]} marked succeeded by HUMAN OVERRIDE (not validated). The reason is recorded in its history.\n${await newlyRunnable(engine)}\n`,
  );
  return ExitCode.Success;
}

async function commit(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const reference = singleReference('task commit', args, context);
  if (reference === undefined) {
    return ExitCode.Usage;
  }
  const outcome = await engine.commitTask(reference);
  const subject = outcome.message.split('\n')[0];
  context.stdout.write(
    [
      `Committed ${outcome.paths.length} file(s) as ${outcome.commit.sha.slice(0, 12)}: ${subject}`,
      ...outcome.paths.map((path) => `  ${path}`),
      'Only the task\'s own changes were committed; other changes were left as they were. Nothing was pushed.',
      '',
    ].join('\n'),
  );
  return ExitCode.Success;
}

async function accept(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task accept', args, context, { note: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task accept', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  void engine;
  context.stderr.write(
    'forge task accept: removed — tasks now succeed only through deterministic validation.\n' +
      `Use: forge task validate ${positionals[0]}   (re-run the configured checks)\n` +
      ` or:  forge task override ${positionals[0]} --reason "..."   (explicit, recorded human override)\n`,
  );
  return ExitCode.Usage;
}

async function reject(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task reject', args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task reject', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write('forge task reject: --reason <text> is required\n');
    return ExitCode.Usage;
  }
  await engine.rejectTask(positionals[0]!, reason);
  const view = (await engine.view()).task(await engine.resolveTask(positionals[0]!))!;
  context.stdout.write(`Task ${view.key} rejected: now ${view.condition} (${view.attemptsRemaining} attempt(s) remaining).\n`);
  return ExitCode.Success;
}

async function cancel(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task cancel', args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task cancel', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  await engine.cancelTask(positionals[0]!, stringOption(parsed, 'reason') ?? null);
  context.stdout.write(`Task ${positionals[0]} cancelled. Tasks that depend on it are now blocked.\n`);
  return ExitCode.Success;
}

async function recover(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task recover', args, context, { force: { type: 'boolean' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task recover', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  await engine.recoverTask(positionals[0]!, { force: booleanOption(parsed, 'force') });
  const view = (await engine.view()).task(await engine.resolveTask(positionals[0]!))!;
  context.stdout.write(
    `Task ${view.key} recovered: the interrupted attempt is recorded as failed (nothing was re-run).\n` +
      `It is now ${view.condition}${view.runnable ? `; run it again with: forge task run ${view.key}` : ''}.\n`,
  );
  return ExitCode.Success;
}

function singleReference(command: string, args: readonly string[], context: CliContext): string | undefined {
  const parsed = parseCommandArgs(command, args, context, {});
  return parsed === undefined ? undefined : expectPositionals(command, parsed, ['task'], context)?.[0];
}

function formatTaskBanner(worker: Worker, task: TaskView, projectName: string, access: 'edit' | 'read-only', timeoutMs: number): string {
  const accessText = access === 'edit' ? 'edit — the worker MAY MODIFY FILES in the project' : 'read-only — the worker cannot modify files';
  return [
    `Forge is invoking AI worker "${worker.displayName}" (${worker.id}) for ONE task.`,
    `  Project:  ${projectName}`,
    `  Task:     ${task.key} ${task.task.title}`,
    `  Attempt:  ${task.attemptsUsed + 1} of ${task.task.maxAttempts}`,
    `  Access:   ${accessText}`,
    `  Timeout:  ${Math.round(timeoutMs / 1000)} s`,
    '',
    '',
  ].join('\n');
}

function formatRunReport(outcome: TaskRunOutcome, before: TaskView, view: WorkflowView): string {
  const result = outcome.run.result;
  const post = outcome.run.post;
  const lines = [
    `Task ${before.key}: ${before.task.title}`,
    `Worker:   ${result.workerId} — ${result.outcome}, ${(result.durationMs / 1000).toFixed(1)} s`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(`          ${diagnostic}`);
  }
  if (result.summary !== null) {
    const summary = result.summary.trim().replace(/\s+/g, ' ');
    lines.push(`Worker's claim (not evidence): ${summary.length <= 300 ? summary : `${summary.slice(0, 299)}…`}`);
  }
  if (post?.changes !== null && post?.changes !== undefined) {
    lines.push(formatChanges(post.changes).trimEnd());
  }
  if (post?.validation !== null && post?.validation !== undefined) {
    lines.push('Validation:', formatValidation(post.validation).trimEnd());
  }
  lines.push(`Forge decision: ${decisionLabel(outcome.task)}`);
  const note = outcome.task?.lastAttempt?.note;
  if (note !== null && note !== undefined) {
    lines.push(`Reason:   ${note}`);
  }
  if (outcome.task !== undefined) {
    lines.push(`Attempt:  ${outcome.task.attemptsUsed}/${outcome.task.task.maxAttempts}`);
    if (outcome.task.condition === 'retryable') {
      lines.push(`Retry available: forge task run ${outcome.task.key}${outcome.task.requiresIntegrityAcknowledgement ? ' --acknowledge-integrity-violation' : ''}`);
    }
    if (outcome.task.condition === 'awaiting-validation') {
      lines.push(`Next: forge task validate ${outcome.task.key}   or   forge task override ${outcome.task.key} --reason "..."`);
    }
    if (outcome.task.task.status === 'succeeded') {
      lines.push(`Commit: forge task commit ${outcome.task.key}   (optional; local only)`);
    }
  }
  lines.push(view.runnable.length === 0 ? 'Next runnable: none' : `Next runnable: ${view.runnable.map((task) => task.key).join(', ')}`);
  lines.push('Nothing else was started.');
  return `${lines.join('\n')}\n`;
}

function decisionLabel(task: TaskView | undefined): string {
  if (task === undefined) {
    return 'UNKNOWN (state could not be read back)';
  }
  switch (task.task.status) {
    case 'succeeded':
      return task.lastAttempt?.outcome === 'overridden' ? 'SUCCEEDED (human override)' : 'SUCCEEDED';
    case 'awaiting-validation':
      return 'AWAITING VALIDATION';
    case 'failed':
      return `FAILED (${task.lastAttempt?.outcome ?? 'failed'})`;
    default:
      return task.task.status.toUpperCase();
  }
}

async function newlyRunnable(engine: TaskEngine): Promise<string> {
  const view = await engine.view();
  if (view.runnable.length === 0) {
    return 'No tasks are runnable now.\n';
  }
  return `Runnable now: ${view.runnable.map((task) => task.key).join(', ')} (nothing was started).\n`;
}
