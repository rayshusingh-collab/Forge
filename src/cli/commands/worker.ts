import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { discoverProject } from '../../projects/index.ts';
import type { WorkerRunStatus } from '../../state/index.ts';
import { WORKER_REQUEST_LIMITS, prepareWorkerRequest, runRecordedWorker } from '../../workers/index.ts';
import type { RecordedRun, Worker, WorkerHealth, WorkerRequest, WorkerResult } from '../../workers/index.ts';
import { requireConfig, resolveWorkers } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

const MAX_TIMEOUT_SECONDS = WORKER_REQUEST_LIMITS.maxTimeoutMs / 1000;

const USAGE = [
  'forge worker <subcommand>',
  '',
  'Subcommands:',
  '  list                  List available workers',
  '  check <worker>        Check that a worker is installed and usable (no AI call)',
  '  run <worker> --task <text> [options]',
  '                        Invoke an AI worker once in the current Forge project',
  '',
  'Run options:',
  '  --task <text>         Instruction for the worker (required)',
  '  --context <text>      Supporting information, kept separate from the task',
  '  --cwd <dir>           Directory inside the project to run in (default: project root)',
  `  --timeout <seconds>   Stop the worker after this long (1-${MAX_TIMEOUT_SECONDS}; default: FORGE_WORKER_TIMEOUT_MS)`,
  '  --allow-edits         Let the worker modify files in the directory (default: read-only)',
  '',
  'Workers never run shell commands, commit, or continue to other tasks.',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { list: runList, check: runCheck, run: runWorker };

export const workerCommand: CliCommand = {
  name: 'worker',
  summary: 'Inspect and manually run AI coding workers',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge worker: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    return subcommand(rest, context);
  },
};

async function runList(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  if (args.length > 0) {
    context.stderr.write(`forge worker list: unexpected argument "${args[0]}"\n`);
    return ExitCode.Usage;
  }
  for (const worker of resolveWorkers(context, { lenient: true }).list()) {
    const aliases = worker.aliases.length === 0 ? '' : ` (alias: ${worker.aliases.join(', ')})`;
    context.stdout.write(`${worker.id}${aliases} — ${worker.displayName}\n`);
  }
  return ExitCode.Success;
}

async function runCheck(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  if (args.length !== 1) {
    context.stderr.write('forge worker check: expected exactly one <worker>\n');
    return ExitCode.Usage;
  }
  const worker = createWorker(args[0]!, context);
  if (worker === undefined) {
    return ExitCode.Usage;
  }
  const health = await worker.healthCheck();
  context.stdout.write(formatHealth(worker, health));
  return health.available ? ExitCode.Success : ExitCode.Failure;
}

async function runWorker(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        task: { type: 'string' },
        context: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'string' },
        'allow-edits': { type: 'boolean' },
      },
    });
  } catch (error) {
    context.stderr.write(`forge worker run: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.Usage;
  }

  const [workerName, ...extra] = parsed.positionals;
  if (workerName === undefined || extra.length > 0) {
    context.stderr.write('forge worker run: expected exactly one <worker>, e.g. `forge worker run claude --task "..."`\n');
    return ExitCode.Usage;
  }
  const task = parsed.values.task;
  if (task === undefined || task.trim() === '') {
    context.stderr.write('forge worker run: --task <text> is required\n');
    return ExitCode.Usage;
  }
  const timeoutSeconds = parseTimeoutSeconds(parsed.values.timeout);
  if (timeoutSeconds === 'invalid') {
    context.stderr.write(`forge worker run: --timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}\n`);
    return ExitCode.Usage;
  }

  const config = requireConfig(context);
  const worker = createWorker(workerName, context);
  if (worker === undefined) {
    return ExitCode.Usage;
  }

  const project = await discoverProject(context.cwd);
  if (project === undefined) {
    context.stderr.write(
      `forge worker run: no Forge project found at or above ${context.cwd}\n` +
        'Workers only run inside registered projects. Register one with: forge project add <path>\n',
    );
    return ExitCode.Failure;
  }

  const request = await prepareWorkerRequest({
    project,
    task,
    context: parsed.values.context ?? null,
    ...(parsed.values.cwd === undefined ? {} : { workingDirectory: resolve(context.cwd, parsed.values.cwd) }),
    access: parsed.values['allow-edits'] === true ? 'edit' : 'read-only',
    timeoutMs: timeoutSeconds === undefined ? config.workerTimeoutMs : timeoutSeconds * 1000,
  });

  context.stderr.write(formatBanner(worker, request, project.project.name));

  const recorded = await runRecordedWorker({
    worker,
    request,
    project,
    trigger: 'manual',
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });

  context.stdout.write(formatResult(recorded.result, recorded.status));
  if (!recorded.integrity.ok) {
    context.stderr.write(formatIntegrityViolation(recorded));
  }
  if (recorded.persistenceError !== undefined) {
    context.stderr.write(`forge worker run: the result was not saved to project state: ${recorded.persistenceError.message}\n`);
    return ExitCode.Failure;
  }
  return recorded.status === 'success' ? ExitCode.Success : ExitCode.Failure;
}

function formatIntegrityViolation(recorded: RecordedRun): string {
  const lines = [
    '',
    'SECURITY: Forge control state (.forge/) was modified during this worker run.',
    'The run is NOT treated as successful, whatever the worker reported.',
    ...recorded.integrity.changes.map((change) => `  ${change.change}: .forge/${change.path === '.' ? '' : change.path}`),
    ...recorded.integrity.problems.map((problem) => `  now invalid: ${problem}`),
    `  Evidence report: ${recorded.evidencePath ?? 'could not be written'}`,
    'Forge did not restore or reset anything. Inspect .forge/ before running Forge on this project again.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function createWorker(name: string, context: CliContext): Worker | undefined {
  const registry = resolveWorkers(context, { lenient: true });
  const worker = registry.create(name);
  if (worker === undefined) {
    const known = registry.list().flatMap((entry) => [entry.id, ...entry.aliases]);
    context.stderr.write(`forge worker: unknown worker "${name}" (available: ${known.join(', ')})\n`);
  }
  return worker;
}

function parseTimeoutSeconds(value: string | undefined): number | undefined | 'invalid' {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value.trim())) {
    return 'invalid';
  }
  const seconds = Number(value.trim());
  return seconds >= 1 && seconds <= MAX_TIMEOUT_SECONDS ? seconds : 'invalid';
}

function formatBanner(worker: Worker, request: WorkerRequest, projectName: string): string {
  const access =
    request.access === 'edit'
      ? 'edit — the worker MAY MODIFY FILES in this directory'
      : 'read-only — the worker cannot modify files';
  return [
    `Forge is invoking AI worker "${worker.displayName}" (${worker.id}).`,
    `  Project:   ${projectName} (${request.projectId})`,
    `  Directory: ${request.workingDirectory}`,
    `  Access:    ${access}`,
    `  Timeout:   ${Math.round(request.timeoutMs / 1000)} s`,
    `  Run ID:    ${request.id}`,
    '',
    '',
  ].join('\n');
}

export function formatResult(result: WorkerResult, status: WorkerRunStatus): string {
  const lines = [
    `Outcome:  ${status}`,
    ...(status === result.outcome ? [] : [`Worker reported: ${result.outcome} (overridden by Forge)`]),
    `Duration: ${(result.durationMs / 1000).toFixed(1)} s`,
    `Run ID:   ${result.requestId}`,
  ];
  const cost = result.provider['costUsd'];
  if (typeof cost === 'number') {
    lines.push(`Cost:     $${cost.toFixed(4)} (as reported by the worker)`);
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`Note:     ${diagnostic}`);
  }
  if (result.summary !== null) {
    lines.push('', 'Worker summary:', result.summary.trim());
  }
  return `${lines.join('\n')}\n`;
}

function formatHealth(worker: Worker, health: WorkerHealth): string {
  const lines = [`${worker.displayName} (${worker.id}): ${health.available ? 'available' : 'NOT available'}`];
  for (const check of health.checks) {
    lines.push(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
  }
  return `${lines.join('\n')}\n`;
}
