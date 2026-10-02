import { StateConflictError, ValidationError, WorkflowError } from '../../core/errors.ts';
import { runPreflight } from '../../control/index.ts';
import { Orchestrator, previewRun, recoverOrchestrationLease, resolvePolicy } from '../../orchestration/index.ts';
import type { PolicyOptions, PolicyResolution } from '../../orchestration/index.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { ORCHESTRATION_LIMITS } from '../../state/index.ts';
import { TaskEngine } from '../../tasks/index.ts';
import { booleanOption, optionalBoolean, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import type { ParsedArgs } from '../args.ts';
import { formatPreflight } from '../control-format.ts';
import { createAiProvider, createRunner, loadProjectSettings, requireConfig, resolveRegistries } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { formatPolicyHeader, formatPreview, formatRunResult, formatRunStatus, formatStep } from '../run-format.ts';
import { MAX_TIMEOUT_SECONDS, createWorker, parseTimeoutSeconds } from './worker.ts';

const USAGE = [
  'forge run [step | status | recover] [options]',
  '',
  'forge run [options]              Run the bounded autonomous loop until done, blocked, or a limit',
  'forge run step [options]         Perform exactly ONE workflow step, then stop',
  'forge run --dry-run [options]    Show the policy and what would happen next (changes nothing)',
  'forge run status                 Show orchestration state, history, and blockers',
  'forge run recover --reason <text> [--force]',
  '                                 Remove a crashed run\'s orchestration lock (owner must be provably gone;',
  '                                 --force requests a human approval instead)',
  '',
  'Hands-off mode:',
  '  --autonomous               Handle recoverable engineering events automatically, within bounded budgets:',
  '                             edits, AI review, auto-decision, validation and review repairs, safe local',
  '                             commits, timeout recovery (continue safe partial work with a longer timeout),',
  '                             provider retries, and evidence re-review. Hard safety stops never change.',
  '                             Every option below still overrides it (e.g. --autonomous --no-auto-commit).',
  `  --timeout-recoveries <n>   Continuations of a timed-out attempt per task (autonomous 2, max ${ORCHESTRATION_LIMITS.maxTimeoutRecoveries})`,
  '  --timeout-increase <seconds>  Worker timeout added per timeout recovery (autonomous: half the timeout)',
  '  --max-worker-timeout <seconds> Hard cap on a recovery\'s worker timeout (autonomous: twice the timeout)',
  `  --provider-retries <n>     Retries after transient provider failures (autonomous 2, max ${ORCHESTRATION_LIMITS.maxProviderRetries})`,
  `  --retry-backoff <seconds>  Wait before the Nth provider retry: N x this (autonomous 5, max ${ORCHESTRATION_LIMITS.maxRetryBackoffMs / 1000})`,
  `  --evidence-reviews <n>     Re-reviews with expanded evidence per attempt (autonomous 1, max ${ORCHESTRATION_LIMITS.maxEvidenceReviews})`,
  '',
  'Policy options override the project configuration (`forge config`); --no-<option> turns one off:',
  '  --allow-edits              Let the implementer modify files (required for real progress)',
  '  --worker <name>            Implementer (default: providers.implementer)',
  '  --timeout <seconds>        Implementer timeout per attempt',
  `  --max-tasks <n>            Distinct tasks per run (default 5, max ${ORCHESTRATION_LIMITS.maxTasks})`,
  `  --max-steps <n>            Workflow steps per run (default 30, max ${ORCHESTRATION_LIMITS.maxSteps})`,
  '  --repair                   Repair automatically after failed deterministic validation',
  '  --repair-review            Repair automatically after blocking review concerns (requires --review)',
  `  --max-repairs <n>          Repairs per task, across runs (default 2, max ${ORCHESTRATION_LIMITS.maxRepairsPerTask})`,
  '  --review                   Run an advisory AI review of every validated task',
  '  --reviewer <name>          Reviewer provider (implies --review)',
  '  --review-timeout <seconds> Reviewer timeout',
  '  --continue-on-concerns     Do not stop for review warnings (blocking concerns still stop)',
  '  --continue-without-review  Continue unreviewed when the reviewer is unavailable (default: stop)',
  '  --auto-decide              Let the AI decision-maker accept, reject (repair) or escalate reviews',
  '                             that would otherwise stop for a human (requires --review)',
  '  --decision-maker <name>    Decision-maker provider (implies --auto-decide; default: providers.decisionMaker)',
  '  --decision-timeout <seconds> Decision-maker timeout',
  '  --auto-commit              Commit each validated task\'s own changes locally (never pushes)',
  '',
  'Precedence: hard limits > command-line option > project configuration > default.',
  'Values above the hard maximums are refused, not clamped. Forge never pushes, never',
  'overrides validation, and never acknowledges violations or approves anything on its own.',
  'Auto-decision only judges reviews of validated work: accepting needs high confidence and',
  'evidence; low confidence, malformed answers and provider failures stop for a human.',
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
  'auto-decide': { type: 'boolean' },
  'decision-maker': { type: 'string' },
  'decision-timeout': { type: 'string' },
  'auto-commit': { type: 'boolean' },
  autonomous: { type: 'boolean' },
  'timeout-recoveries': { type: 'string' },
  'timeout-increase': { type: 'string' },
  'max-worker-timeout': { type: 'string' },
  'provider-retries': { type: 'string' },
  'retry-backoff': { type: 'string' },
  'evidence-reviews': { type: 'string' },
} as const;

export const runCommand: CliCommand = {
  name: 'run',
  summary: 'Run the bounded autonomous orchestration loop (or one step, a dry run, status, or lease recovery)',
  usage: USAGE,
  async run(args, context) {
    const [first, ...rest] = args;
    if (first === 'status') {
      return status(rest, context);
    }
    if (first === 'recover') {
      return recover(rest, context);
    }
    const mode = first === 'step' ? 'step' : 'run';
    return execute(mode, mode === 'step' ? rest : args, context);
  },
};

async function execute(mode: 'run' | 'step', args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const command = mode === 'step' ? 'run step' : 'run';
  const parsed = parseCommandArgs(command, args, context, { ...POLICY_OPTIONS, 'dry-run': { type: 'boolean' } }, { allowNegative: true });
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
  const resolution = parsePolicy(command, parsed, context, config.workerTimeoutMs, (await loadProjectSettings(project)).settings);
  if (resolution === undefined) {
    return ExitCode.Usage;
  }
  const { policy } = resolution;
  const runner = createRunner(context, config);
  const store = openStateStore(project);

  if (booleanOption(parsed, 'dry-run')) {
    const preview = await previewRun({ project, store, runner, policy });
    context.stdout.write(formatPreview(project.project.name, policy, preview, resolution.sources));
    return ExitCode.Success;
  }

  if (policy.autonomous) {
    await recoverProvablyDeadLease(project, store, context);
  }

  // The same safety checks `forge preflight` reports; any critical failure refuses the run before anything starts.
  const preflight = await runPreflight({ project, store, runner, policy, registries: resolveRegistries(context) });
  if (!preflight.runnable) {
    context.stderr.write(`forge ${command}: preflight failed; nothing was started.\n${formatPreflight(preflight, { onlyProblems: true })}`);
    return ExitCode.Failure;
  }

  const worker = createWorker(policy.worker, context);
  const reviewer = policy.review.enabled ? createAiProvider(policy.review.reviewer!, 'reviewer', context) : null;
  const decisionMaker = policy.decision.enabled ? createAiProvider(policy.decision.provider!, 'decision-maker', context) : null;
  if (worker === undefined || reviewer === undefined || decisionMaker === undefined) {
    return ExitCode.Usage;
  }

  context.stdout.write(formatPolicyHeader(project.project.name, mode, policy, worker, reviewer, resolution.sources, decisionMaker));
  const engine = new TaskEngine({ project, store, runner });
  const orchestrator = new Orchestrator({
    project,
    store,
    engine,
    runner,
    worker,
    reviewer,
    decisionMaker,
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

/**
 * Hands-off continuation after a crash: an autonomous run removes the
 * orchestration lock (and state lock) of a previous run ONLY when Forge can
 * prove its owner is gone — a process on this machine that no longer exists,
 * running a run this project's state knows. This is exactly
 * `forge run recover` without `--force`, recorded as a control event.
 * Anything unprovable is left alone and the run refuses as usual; a forced
 * recovery always needs a human.
 */
async function recoverProvablyDeadLease(project: LoadedProject, store: ReturnType<typeof openStateStore>, context: CliContext): Promise<void> {
  try {
    const result = await recoverOrchestrationLease({ project, store, reason: 'autonomous run: the previous owner provably no longer exists', force: false });
    if (result.kind === 'recovered') {
      context.stdout.write(
        `Recovered the stale orchestration lease${result.owner === null ? '' : ` of crashed run ${result.owner.runId.slice(0, 8)} (pid ${result.owner.pid}, which no longer exists)`}; continuing from the recorded state.\n`,
      );
    }
  } catch (error) {
    if (!(error instanceof WorkflowError)) {
      throw error;
    }
    // Not provably stale (a live owner, another host, an unknown run): never taken over here.
  }
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
  const { policy } = resolvePolicy({}, (await loadProjectSettings(project)).settings, { workerTimeoutMs: config.workerTimeoutMs });
  const preview = await previewRun({ project, store: openStateStore(project), runner: createRunner(context, config), policy });
  context.stdout.write(formatRunStatus(project.project.name, policy, preview));
  return ExitCode.Success;
}

async function recover(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('run recover', args, context, { reason: { type: 'string' }, force: { type: 'boolean' } });
  if (parsed === undefined || parsed.positionals.length > 0) {
    if (parsed !== undefined) {
      context.stderr.write('forge run recover: expected no arguments\n');
    }
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write('forge run recover: --reason <text> is required; lease recoveries are recorded\n');
    return ExitCode.Usage;
  }
  const project = await requireProject('run recover', context);
  if (typeof project === 'number') {
    return project;
  }
  const result = await recoverOrchestrationLease({ project, store: openStateStore(project), reason, force: booleanOption(parsed, 'force') });
  switch (result.kind) {
    case 'no-lease':
      context.stdout.write('No orchestration lease or state lock is held; nothing to recover.\n');
      return ExitCode.Success;
    case 'approval-required':
      context.stdout.write(
        [
          `Forced lease recovery needs a human approval: ${result.why}.`,
          `Approval ${result.approvalId.slice(0, 8)} ${result.created ? 'was requested' : 'is pending'}.`,
          `Inspect it with: forge approval show ${result.approvalId.slice(0, 8)}`,
          `Approve with:    forge approval approve ${result.approvalId.slice(0, 8)} --reason "..."`,
          'Then run `forge run recover --force --reason "..."` again. The lock must still be byte-identical.',
          'Nothing was removed.',
          '',
        ].join('\n'),
      );
      return ExitCode.Failure;
    case 'recovered':
      context.stdout.write(
        [
          `Recovered the orchestration lease${result.owner === null ? '' : ` of run ${result.owner.runId.slice(0, 8)} (pid ${result.owner.pid} on ${result.owner.host})`}${result.forced ? ' (forced, with a human approval)' : ' (its owner process no longer exists)'}.`,
          ...(result.stateLockRemoved ? ['The stale state lock left by the crashed process was removed too.'] : []),
          result.owner === null ? 'No orchestration run was involved.' : result.runMarkedInterrupted ? 'The run is now recorded as interrupted.' : 'The run had already recorded how it ended.',
          'No task was re-run. Interrupted tasks still need their own recovery (see `forge explain`).',
          '',
        ].join('\n'),
      );
      return ExitCode.Success;
  }
}

/** Builds the policy: command-line options over project configuration; out-of-range values are refused with the hard limits. */
function parsePolicy(command: string, parsed: ParsedArgs, context: CliContext, workerTimeoutMs: number, project: Parameters<typeof resolvePolicy>[1]): PolicyResolution | undefined {
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
  const seconds0 = (name: string, maxSeconds: number): number | undefined => {
    const text = stringOption(parsed, name);
    if (text === undefined) {
      return undefined;
    }
    if (!/^\d{1,6}$/.test(text.trim()) || Number(text.trim()) > maxSeconds) {
      problems.push(`--${name} must be a whole number of seconds between 0 and ${maxSeconds}`);
      return undefined;
    }
    return Number(text.trim()) * 1000;
  };
  const allowEdits = optionalBoolean(parsed, 'allow-edits');
  const reviewer = stringOption(parsed, 'reviewer');
  const review = optionalBoolean(parsed, 'review') ?? (reviewer === undefined ? undefined : true);
  const decisionMaker = stringOption(parsed, 'decision-maker');
  const autoDecide = optionalBoolean(parsed, 'auto-decide') ?? (decisionMaker === undefined ? undefined : true);
  const cli: PolicyOptions = {
    ...optional<'access', 'edit' | 'read-only'>('access', allowEdits === undefined ? undefined : allowEdits ? 'edit' : 'read-only'),
    ...optional('worker', stringOption(parsed, 'worker')),
    ...optional('workerTimeoutMs', seconds('timeout')),
    ...optional('maxTasks', count('max-tasks')),
    ...optional('maxSteps', count('max-steps')),
    ...optional('maxRepairsPerTask', count('max-repairs')),
    ...optional('repairOnValidationFailure', optionalBoolean(parsed, 'repair')),
    ...optional('repairOnBlockingReview', optionalBoolean(parsed, 'repair-review')),
    ...optional('review', review),
    ...optional('reviewer', reviewer),
    ...optional('reviewTimeoutMs', seconds('review-timeout')),
    ...optional('continueOnConcerns', optionalBoolean(parsed, 'continue-on-concerns')),
    ...optional('continueWithoutReview', optionalBoolean(parsed, 'continue-without-review')),
    ...optional('autoDecide', autoDecide),
    ...optional('decisionMaker', decisionMaker),
    ...optional('decisionTimeoutMs', seconds('decision-timeout')),
    ...optional('autoCommit', optionalBoolean(parsed, 'auto-commit')),
    ...optional('autonomous', optionalBoolean(parsed, 'autonomous')),
    ...optional('timeoutRecoveries', count('timeout-recoveries')),
    ...optional('timeoutIncreaseMs', seconds0('timeout-increase', MAX_TIMEOUT_SECONDS)),
    ...optional('maxWorkerTimeoutMs', seconds('max-worker-timeout')),
    ...optional('providerRetries', count('provider-retries')),
    ...optional('retryBackoffMs', seconds0('retry-backoff', ORCHESTRATION_LIMITS.maxRetryBackoffMs / 1000)),
    ...optional('evidenceReviews', count('evidence-reviews')),
  };
  if (problems.length === 0) {
    try {
      return resolvePolicy(cli, project, { workerTimeoutMs });
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
