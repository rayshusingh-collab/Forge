import { StateConflictError, ValidationError } from '../../core/errors.ts';
import { Orchestrator, buildPolicy, previewRun } from '../../orchestration/index.ts';
import type { PolicyOptions } from '../../orchestration/index.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { ORCHESTRATION_LIMITS } from '../../state/index.ts';
import type { OrchestrationPolicy } from '../../state/index.ts';
import { TaskEngine } from '../../tasks/index.ts';
import { booleanOption, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import type { ParsedArgs } from '../args.ts';
import { createAiProvider, createRunner, requireConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { formatPolicyHeader, formatPreview, formatRunResult, formatRunStatus, formatStep } from '../run-format.ts';
import { MAX_TIMEOUT_SECONDS, createWorker, parseTimeoutSeconds } from './worker.ts';

const USAGE = [
  'forge run [step | status] [options]',
  '',
  'forge run [options]              Run the bounded autonomous loop until done, blocked, or a limit',
  'forge run step [options]         Perform exactly ONE workflow step, then stop',
  'forge run --dry-run [options]    Show the policy and what would happen next (changes nothing)',
  'forge run status                 Show orchestration state, history, and blockers',
  '',
  'Policy options (defaults are conservative; nothing risky is enabled implicitly):',
  '  --allow-edits              Let the implementer modify files (required for real progress)',
  '  --worker <name>            Implementer (default: claude)',
  '  --timeout <seconds>        Implementer timeout per attempt',
  `  --max-tasks <n>            Distinct tasks per run (default 5, max ${ORCHESTRATION_LIMITS.maxTasks})`,
  `  --max-steps <n>            Workflow steps per run (default 30, max ${ORCHESTRATION_LIMITS.maxSteps})`,
  '  --repair                   Repair automatically after failed deterministic validation',
  '  --repair-review            Repair automatically after blocking review concerns (requires --review)',
  `  --max-repairs <n>          Repairs per task, across runs (default 2, max ${ORCHESTRATION_LIMITS.maxRepairsPerTask})`,
  '  --review                   Run an advisory AI review of every validated task',
  '  --reviewer <name>          Reviewer provider (default: claude; implies --review)',
  '  --review-timeout <seconds> Reviewer timeout',
  '  --continue-on-concerns     Do not stop for review warnings (blocking concerns still stop)',
  '  --continue-without-review  Continue unreviewed when the reviewer is unavailable (default: stop)',
  '  --auto-commit              Commit each validated task\'s own changes locally (never pushes)',
  '',
  'Values above the hard maximums are refused, not clamped. Forge never pushes, never',
  'overrides validation, and never acknowledges violations on its own.',
].join('\n');

const POLICY_OPTIONS = {
  'allow-edits': { type: 'boolean' },
  worker: { type: 'string' },
  timeout: { type: 'string' },
  'max-tasks': { type: 'string' },
  'max-steps': { type: 'string' },
  repair: { type: 'boolean' },
  'repair-review': { type: 'boolean' },
  'max-repairs': { type: 'string' },
  review: { type: 'boolean' },
  reviewer: { type: 'string' },
  'review-timeout': { type: 'string' },
  'continue-on-concerns': { type: 'boolean' },
  'continue-without-review': { type: 'boolean' },
  'auto-commit': { type: 'boolean' },
} as const;

export const runCommand: CliCommand = {
  name: 'run',
  summary: 'Run the bounded autonomous orchestration loop (or one step, a dry run, or status)',
  usage: USAGE,
  async run(args, context) {
    const [first, ...rest] = args;
    if (first === 'status') {
      return status(rest, context);
    }
    const mode = first === 'step' ? 'step' : 'run';
    return execute(mode, mode === 'step' ? rest : args, context);
  },
};

async function execute(mode: 'run' | 'step', args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const command = mode === 'step' ? 'run step' : 'run';
  const parsed = parseCommandArgs(command, args, context, { ...POLICY_OPTIONS, 'dry-run': { type: 'boolean' } });
  if (parsed === undefined) {
    return ExitCode.Usage;
  }
  if (parsed.positionals.length > 0) {
    context.stderr.write(`forge ${command}: unexpected argument "${parsed.positionals[0]}"\n\nUsage:\n${USAGE}\n`);
    return ExitCode.Usage;
  }
  const project = await requireProject(command, context);
  if (typeof project === 'number') {
    return project;
  }
  const config = requireConfig(context);
  const policy = parsePolicy(command, parsed, context, config.workerTimeoutMs);
  if (policy === undefined) {
    return ExitCode.Usage;
  }
  const runner = createRunner(context, config);
  const store = openStateStore(project);

  if (booleanOption(parsed, 'dry-run')) {
    const preview = await previewRun({ project, store, runner, policy });
    context.stdout.write(formatPreview(project.project.name, policy, preview));
    return ExitCode.Success;
  }

  const worker = createWorker(policy.worker, context);
  const reviewer = policy.review.enabled ? createAiProvider(policy.review.reviewer!, 'reviewer', context) : null;
  if (worker === undefined || reviewer === undefined) {
    return ExitCode.Usage;
  }

  context.stdout.write(formatPolicyHeader(project.project.name, mode, policy, worker, reviewer));
  const engine = new TaskEngine({ project, store, runner });
  const orchestrator = new Orchestrator({
    project,
    store,
    engine,
    runner,
    worker,
    reviewer,
    policy,
    reporter: { onStep: (step) => context.stdout.write(formatStep(step)) },
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  let result;
  try {
    result = await orchestrator.run(mode);
  } catch (error) {
    if (error instanceof StateConflictError) {
      context.stderr.write(`forge ${command}: ${error.message}\nNothing was started.\n`);
      return ExitCode.Failure;
    }
    throw error;
  }
  context.stdout.write(formatRunResult(result));
  return ['complete', 'no-work', 'step-done', 'limit-steps', 'limit-tasks'].includes(result.stop.reason) && result.recorded ? ExitCode.Success : ExitCode.Failure;
}

async function status(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('run status', args, context, {});
  if (parsed === undefined || parsed.positionals.length > 0) {
    if (parsed !== undefined) {
      context.stderr.write('forge run status: expected no arguments\n');
    }
    return ExitCode.Usage;
  }
  const project: LoadedProject | ExitCodeValue = await requireProject('run status', context);
  if (typeof project === 'number') {
    return project;
  }
  const config = requireConfig(context);
  const policy = buildPolicy({}, { workerTimeoutMs: config.workerTimeoutMs });
  const preview = await previewRun({ project, store: openStateStore(project), runner: createRunner(context, config), policy });
  context.stdout.write(formatRunStatus(project.project.name, policy, preview));
  return ExitCode.Success;
}

/** Builds the policy from explicit options; out-of-range values are refused with the hard limits. */
function parsePolicy(command: string, parsed: ParsedArgs, context: CliContext, workerTimeoutMs: number): OrchestrationPolicy | undefined {
  const problems: string[] = [];
  const count = (name: string): number | undefined => {
    const text = stringOption(parsed, name);
    if (text === undefined) {
      return undefined;
    }
    if (!/^\d{1,4}$/.test(text.trim())) {
      problems.push(`--${name} must be a whole number`);
      return undefined;
    }
    return Number(text.trim());
  };
  const seconds = (name: string): number | undefined => {
    const value = parseTimeoutSeconds(stringOption(parsed, name));
    if (value === 'invalid') {
      problems.push(`--${name} must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}`);
      return undefined;
    }
    return value === undefined ? undefined : value * 1000;
  };
  const options: PolicyOptions = {
    access: booleanOption(parsed, 'allow-edits') ? 'edit' : 'read-only',
    ...optional('worker', stringOption(parsed, 'worker')),
    ...optional('workerTimeoutMs', seconds('timeout')),
    ...optional('maxTasks', count('max-tasks')),
    ...optional('maxSteps', count('max-steps')),
    ...optional('maxRepairsPerTask', count('max-repairs')),
    repairOnValidationFailure: booleanOption(parsed, 'repair'),
    repairOnBlockingReview: booleanOption(parsed, 'repair-review'),
    review: booleanOption(parsed, 'review'),
    ...optional('reviewer', stringOption(parsed, 'reviewer')),
    ...optional('reviewTimeoutMs', seconds('review-timeout')),
    continueOnConcerns: booleanOption(parsed, 'continue-on-concerns'),
    continueWithoutReview: booleanOption(parsed, 'continue-without-review'),
    autoCommit: booleanOption(parsed, 'auto-commit'),
  };
  if (problems.length === 0) {
    try {
      return buildPolicy(options, { workerTimeoutMs });
    } catch (error) {
      if (!(error instanceof ValidationError)) {
        throw error;
      }
      problems.push(error.message);
    }
  }
  context.stderr.write(`forge ${command}: ${problems.join('; ')}\n`);
  return undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
