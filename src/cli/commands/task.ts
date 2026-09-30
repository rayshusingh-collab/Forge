import { TaskEngine, resolveTaskReference } from '../../tasks/index.ts';
import type { TaskView } from '../../tasks/index.ts';
import type { Worker } from '../../workers/index.ts';
import { booleanOption, expectPositionals, listOption, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { requireConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { formatReady, formatTask, formatTaskTable } from '../workflow-format.ts';
import { MAX_TIMEOUT_SECONDS, createWorker, formatIntegrityViolation, formatResult, parseTimeoutSeconds } from './worker.ts';

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
  '                                  Execute ONE attempt of ONE task, then stop',
  '  accept <task> [--note <text>]   Accept a task awaiting validation',
  '  reject <task> --reason <text>   Reject a task awaiting validation',
  '  cancel <task> [--reason <text>] Cancel a pending or failed task',
  '  recover <task> [--force]        Mark an interrupted execution as failed',
  '',
  '<task> is its key (e.g. 1.2 = milestone 1, task 2), full ID, or a unique ID prefix.',
  'Forge owns task status: workers report results, Forge decides transitions.',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext, engine: TaskEngine, projectName: string) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { add, list, show, ready, run, accept, reject, cancel, recover };

export const taskCommand: CliCommand = {
  name: 'task',
  summary: 'Create, inspect, and manually execute tasks',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
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
    return subcommand(rest, context, new TaskEngine({ project }), project.project.name);
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

async function run(args: readonly string[], context: CliContext, engine: TaskEngine, projectName: string): Promise<ExitCodeValue> {
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
  const worker = createWorker(stringOption(parsed, 'worker') ?? 'claude', context);
  if (worker === undefined) {
    return ExitCode.Usage;
  }
  const access = booleanOption(parsed, 'allow-edits') ? 'edit' : 'read-only';
  const timeoutMs = timeoutSeconds === undefined ? config.workerTimeoutMs : timeoutSeconds * 1000;

  // Validate before announcing anything; the engine checks again atomically when starting.
  const before = (await engine.view()).task(await engine.resolveTask(positionals[0]!))!;
  context.stderr.write(formatTaskBanner(worker, before, projectName, access, timeoutMs));

  const outcome = await engine.runTask(before.task.id, {
    worker,
    access,
    timeoutMs,
    acknowledgeIntegrityViolation: booleanOption(parsed, 'acknowledge-integrity-violation'),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  context.stdout.write(formatResult(outcome.run.result, outcome.run.status));
  if (!outcome.run.integrity.ok) {
    context.stderr.write(formatIntegrityViolation(outcome.run));
  }
  if (outcome.run.persistenceError !== undefined) {
    context.stderr.write(
      `forge task run: the outcome was NOT recorded: ${outcome.run.persistenceError.message}\n` +
        `The task stays recorded as running; once you have inspected the project, run: forge task recover ${before.key}\n`,
    );
    return ExitCode.Failure;
  }
  context.stdout.write(`\n${formatAfterRun(outcome.task, before.key)}`);
  return outcome.run.status === 'success' ? ExitCode.Success : ExitCode.Failure;
}

async function accept(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task accept', args, context, { note: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task accept', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  await engine.acceptTask(positionals[0]!, stringOption(parsed, 'note') ?? null);
  context.stdout.write(`Task ${positionals[0]} accepted (succeeded).\n${await newlyRunnable(engine)}`);
  return ExitCode.Success;
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

function formatAfterRun(task: TaskView | undefined, key: string): string {
  if (task === undefined) {
    return `Task ${key}: final state could not be read back; check with: forge task show ${key}\n`;
  }
  const lines = [`Task ${task.key} is now ${task.condition} (attempt ${task.attemptsUsed} of ${task.task.maxAttempts}).`];
  if (task.condition === 'awaiting-validation') {
    lines.push('The worker reported success; that is not proof the work is correct.');
    lines.push(`Review the changes, then: forge task accept ${task.key}   or   forge task reject ${task.key} --reason "..."`);
  } else if (task.condition === 'retryable') {
    lines.push(`Another attempt may be run explicitly with: forge task run ${task.key}`);
  }
  lines.push('Forge did not start any other task.');
  return `${lines.join('\n')}\n`;
}

async function newlyRunnable(engine: TaskEngine): Promise<string> {
  const view = await engine.view();
  if (view.runnable.length === 0) {
    return 'No tasks are runnable now.\n';
  }
  return `Runnable now: ${view.runnable.map((task) => task.key).join(', ')} (nothing was started).\n`;
}
