import { ValidationError } from '../core/errors.ts';
import { fingerprintOf } from '../core/fingerprint.ts';
import { SchemaViolation } from '../core/validation.ts';
import { ORCHESTRATION_LIMITS, decodeOrchestrationPolicy } from '../state/index.ts';
import type { OrchestrationPolicy, WorkerAccessMode } from '../state/index.ts';
import type { ProjectSettings } from '../config/index.ts';

/**
 * Orchestration policy: the complete, explicit list of what `forge run` may
 * do on its own. It is built only from Forge's conservative defaults, the
 * human-controlled project configuration, and options a human passed on the
 * command line; nothing an AI provider, repository file, or validation
 * output says can change it.
 *
 * Precedence: hard limits (never overridable) > CLI option > project
 * configuration > environment (timeouts) > conservative default.
 *
 * Out-of-range values are REFUSED, never clamped: a run either uses exactly
 * the policy it prints, or does not start.
 */

export const POLICY_DEFAULTS = {
  maxTasks: 5,
  maxSteps: 30,
  maxRepairsPerTask: 2,
} as const;

/**
 * What `--autonomous` (or `run.autonomous`) changes: the defaults below,
 * each still overridable by an explicit option. It never relaxes a hard
 * stop (see ALWAYS_STOP_CONDITIONS); it only lets Forge handle recoverable
 * engineering events itself, within these bounded budgets.
 */
export const AUTONOMOUS_DEFAULTS = {
  access: 'edit',
  review: true,
  autoDecide: true,
  repairOnValidationFailure: true,
  repairOnBlockingReview: true,
  autoCommit: true,
  maxTasks: ORCHESTRATION_LIMITS.maxTasks,
  maxSteps: ORCHESTRATION_LIMITS.maxSteps,
  maxRepairsPerTask: 3,
  timeoutRecoveries: 2,
  providerRetries: 2,
  retryBackoffMs: 5_000,
  evidenceReviews: 1,
} as const;

/** Human choices for one run. Absent means "use the conservative default". */
export interface PolicyOptions {
  readonly maxTasks?: number;
  readonly maxSteps?: number;
  readonly access?: WorkerAccessMode;
  readonly worker?: string;
  readonly workerTimeoutMs?: number;
  readonly repairOnValidationFailure?: boolean;
  readonly repairOnBlockingReview?: boolean;
  readonly maxRepairsPerTask?: number;
  readonly review?: boolean;
  readonly reviewer?: string;
  readonly reviewTimeoutMs?: number;
  readonly continueOnConcerns?: boolean;
  readonly continueWithoutReview?: boolean;
  readonly autoDecide?: boolean;
  readonly decisionMaker?: string;
  readonly decisionTimeoutMs?: number;
  readonly autoCommit?: boolean;
  /** Hands-off mode: safe automation defaults for long runs (see AUTONOMOUS_DEFAULTS). */
  readonly autonomous?: boolean;
  /** Timeout recoveries per task (autonomous default 2). */
  readonly timeoutRecoveries?: number;
  /** Added to the worker timeout per successive timeout recovery (autonomous default: half the worker timeout). */
  readonly timeoutIncreaseMs?: number;
  /** Hard cap on any recovery's worker timeout (autonomous default: twice the worker timeout). */
  readonly maxWorkerTimeoutMs?: number;
  /** Retries after transient provider failures (autonomous default 2). */
  readonly providerRetries?: number;
  /** Wait before the Nth provider retry: N × this (autonomous default 5 s). */
  readonly retryBackoffMs?: number;
  /** Evidence-expansion re-reviews per attempt (autonomous default 1). */
  readonly evidenceReviews?: number;
}

/**
 * Conditions that always stop a run, whatever the policy says. Listed so
 * the user sees them before an autonomous run starts.
 */
export const ALWAYS_STOP_CONDITIONS: readonly string[] = [
  'integrity or scope violation (never acknowledged automatically)',
  'interrupted or concurrently running task',
  'task awaiting manual validation (validation is never overridden automatically)',
  'a timed-out or failed worker beyond its recovery budget, or one that left changes Forge cannot attribute to the task',
  'repair, recovery, evidence-review or attempt budget exhausted (each reported by name)',
  'unresolved merge conflicts or other unsafe Git state',
  'AI decision-maker escalation, low confidence, malformed output, or unavailability (never treated as acceptance)',
  'commit refused by the safe-commit rules (e.g. mixed attribution)',
  'provider unavailable when no safe continuation exists',
  'workflow complete, limit reached, or Ctrl+C',
];

export function buildPolicy(given: PolicyOptions, defaults: { readonly workerTimeoutMs: number }): OrchestrationPolicy {
  const autonomous = given.autonomous ?? false;
  const options = autonomous ? withAutonomousDefaults(given) : given;
  const repairOnValidationFailure = options.repairOnValidationFailure ?? false;
  const repairOnBlockingReview = options.repairOnBlockingReview ?? false;
  const maxPerTask = options.maxRepairsPerTask ?? POLICY_DEFAULTS.maxRepairsPerTask;
  const workerTimeoutMs = options.workerTimeoutMs ?? defaults.workerTimeoutMs;
  if ((repairOnValidationFailure || repairOnBlockingReview) && maxPerTask === 0) {
    throw new ValidationError('Repairs are enabled but the repair budget is 0; use a budget of at least 1, or do not enable repairs');
  }
  // An explicit review choice wins; naming a reviewer alone enables review.
  const reviewEnabled = options.review ?? options.reviewer !== undefined;
  if (repairOnBlockingReview && !reviewEnabled) {
    throw new ValidationError('Review-driven repair requires AI review to be enabled (--review)');
  }
  // An explicit auto-decide choice wins; naming a decision-maker alone enables it.
  const decisionEnabled = options.autoDecide ?? options.decisionMaker !== undefined;
  if (decisionEnabled && !reviewEnabled) {
    throw new ValidationError('Auto-decision judges AI reviews, so it requires AI review to be enabled (--review)');
  }
  if (decisionEnabled && (maxPerTask === 0)) {
    throw new ValidationError('Auto-decision rejections are repaired automatically, so the repair budget must be at least 1');
  }
  const candidate = {
    maxTasks: options.maxTasks ?? POLICY_DEFAULTS.maxTasks,
    maxSteps: options.maxSteps ?? POLICY_DEFAULTS.maxSteps,
    access: options.access ?? 'read-only',
    worker: options.worker ?? 'claude',
    workerTimeoutMs,
    repair: { onValidationFailure: repairOnValidationFailure, onBlockingReview: repairOnBlockingReview, maxPerTask },
    review: {
      enabled: reviewEnabled,
      reviewer: reviewEnabled ? (options.reviewer ?? 'claude') : null,
      timeoutMs: options.reviewTimeoutMs ?? defaults.workerTimeoutMs,
      onConcerns: options.continueOnConcerns === true ? 'continue' : 'stop',
      onFailure: options.continueWithoutReview === true ? 'continue' : 'stop',
    },
    decision: {
      enabled: decisionEnabled,
      provider: decisionEnabled ? (options.decisionMaker ?? 'claude') : null,
      timeoutMs: options.decisionTimeoutMs ?? options.reviewTimeoutMs ?? defaults.workerTimeoutMs,
    },
    autoCommit: options.autoCommit ?? false,
    autonomous,
    recovery: {
      timeoutRecoveries: options.timeoutRecoveries ?? 0,
      // Autonomous defaults: 600 s -> 900 s -> 1200 s (cap) for a 600 s worker timeout.
      timeoutIncreaseMs: options.timeoutIncreaseMs ?? (autonomous ? Math.round(workerTimeoutMs / 2) : 0),
      maxWorkerTimeoutMs: options.maxWorkerTimeoutMs ?? (autonomous ? Math.min(workerTimeoutMs * 2, Math.max(workerTimeoutMs, MAX_AUTONOMOUS_TIMEOUT_MS)) : workerTimeoutMs),
      providerRetries: options.providerRetries ?? 0,
      retryBackoffMs: options.retryBackoffMs ?? 0,
      evidenceReviews: options.evidenceReviews ?? 0,
    },
  };
  try {
    // The same decoder guards stored policies, so the hard limits live in one place.
    return decodeOrchestrationPolicy(candidate, 'policy');
  } catch (error) {
    if (error instanceof SchemaViolation) {
      throw new ValidationError(`Invalid orchestration policy: ${error.message} (hard limits: ${describeLimits()})`);
    }
    throw error;
  }
}

/** The default timeout cap never exceeds this; an explicit `maxWorkerTimeoutMs` may (up to the stored 24 h ceiling). */
const MAX_AUTONOMOUS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Fills every option the human did not set with its autonomous default. */
function withAutonomousDefaults(options: PolicyOptions): PolicyOptions {
  const merged: Record<string, unknown> = { ...options };
  for (const [key, value] of Object.entries(AUTONOMOUS_DEFAULTS)) {
    if (merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged as PolicyOptions;
}

export type PolicySource = 'cli' | 'project' | 'default';

export interface PolicyResolution {
  readonly policy: OrchestrationPolicy;
  /** Where each option came from (options not listed used the default). */
  readonly sources: Readonly<Partial<Record<keyof PolicyOptions, PolicySource>>>;
}

/** Project configuration expressed as policy options (only keys the project actually sets). */
export function policyOptionsFromProject(settings: ProjectSettings): PolicyOptions {
  const options: Record<string, unknown> = {};
  const map: readonly (readonly [keyof ProjectSettings, keyof PolicyOptions, (value: unknown) => unknown])[] = [
    ['providers.implementer', 'worker', (value) => value],
    ['providers.reviewer', 'reviewer', (value) => value],
    ['providers.decisionMaker', 'decisionMaker', (value) => value],
    ['run.autoDecide', 'autoDecide', (value) => value],
    ['run.decisionTimeoutSeconds', 'decisionTimeoutMs', (value) => (value as number) * 1000],
    ['run.allowEdits', 'access', (value) => (value === true ? 'edit' : 'read-only')],
    ['run.maxTasks', 'maxTasks', (value) => value],
    ['run.maxSteps', 'maxSteps', (value) => value],
    ['run.repairOnValidationFailure', 'repairOnValidationFailure', (value) => value],
    ['run.repairOnBlockingReview', 'repairOnBlockingReview', (value) => value],
    ['run.maxRepairsPerTask', 'maxRepairsPerTask', (value) => value],
    ['run.review', 'review', (value) => value],
    ['run.continueOnConcerns', 'continueOnConcerns', (value) => value],
    ['run.continueWithoutReview', 'continueWithoutReview', (value) => value],
    ['run.autoCommit', 'autoCommit', (value) => value],
    ['run.workerTimeoutSeconds', 'workerTimeoutMs', (value) => (value as number) * 1000],
    ['run.reviewTimeoutSeconds', 'reviewTimeoutMs', (value) => (value as number) * 1000],
    ['run.autonomous', 'autonomous', (value) => value],
    ['run.timeoutRecoveries', 'timeoutRecoveries', (value) => value],
    ['run.timeoutIncreaseSeconds', 'timeoutIncreaseMs', (value) => (value as number) * 1000],
    ['run.maxWorkerTimeoutSeconds', 'maxWorkerTimeoutMs', (value) => (value as number) * 1000],
    ['run.providerRetries', 'providerRetries', (value) => value],
    ['run.retryBackoffSeconds', 'retryBackoffMs', (value) => (value as number) * 1000],
    ['run.evidenceReviews', 'evidenceReviews', (value) => value],
  ];
  for (const [key, option, convert] of map) {
    const value = settings[key];
    if (value !== undefined) {
      options[option] = convert(value);
    }
  }
  return options as PolicyOptions;
}

/**
 * Applies the precedence rules. A reviewer named only in the project
 * configuration never enables review by itself; `run.review` (or --review)
 * does. Likewise a decision-maker named only there never enables
 * auto-decision; `run.autoDecide` (or --auto-decide) does. The hard limits are enforced last, by `buildPolicy`, whatever the source.
 */
export function resolvePolicy(cli: PolicyOptions, project: ProjectSettings, defaults: { readonly workerTimeoutMs: number }): PolicyResolution {
  const fromProject = policyOptionsFromProject(project);
  const merged: Record<string, unknown> = { ...fromProject };
  const sources: Partial<Record<keyof PolicyOptions, PolicySource>> = {};
  for (const key of Object.keys(fromProject) as (keyof PolicyOptions)[]) {
    sources[key] = 'project';
  }
  for (const [key, value] of Object.entries(cli) as [keyof PolicyOptions, unknown][]) {
    if (value !== undefined) {
      merged[key] = value;
      sources[key] = 'cli';
    }
  }
  if (merged['review'] === undefined && sources.reviewer === 'project') {
    merged['review'] = false;
  }
  if (merged['autoDecide'] === undefined && sources.decisionMaker === 'project') {
    merged['autoDecide'] = false;
  }
  return { policy: buildPolicy(merged as PolicyOptions, defaults), sources };
}

export function describeLimits(): string {
  return `max tasks ${ORCHESTRATION_LIMITS.maxTasks}, max steps ${ORCHESTRATION_LIMITS.maxSteps}, max repairs per task ${ORCHESTRATION_LIMITS.maxRepairsPerTask}, max timeout recoveries ${ORCHESTRATION_LIMITS.maxTimeoutRecoveries}, max provider retries ${ORCHESTRATION_LIMITS.maxProviderRetries}, max evidence reviews ${ORCHESTRATION_LIMITS.maxEvidenceReviews}, max retry backoff ${ORCHESTRATION_LIMITS.maxRetryBackoffMs / 1000} s`;
}

/**
 * Worker timeout for an attempt: the normal timeout, or for the Nth timeout
 * recovery the normal timeout plus N increases, never above the hard cap.
 */
export function workerTimeoutFor(policy: OrchestrationPolicy, timeoutRecovery: number | null): number {
  if (timeoutRecovery === null) {
    return policy.workerTimeoutMs;
  }
  return Math.min(policy.recovery.maxWorkerTimeoutMs, policy.workerTimeoutMs + timeoutRecovery * policy.recovery.timeoutIncreaseMs);
}

/** SHA-256 over the policy with sorted keys, recorded with every run. */
export function policyHash(policy: OrchestrationPolicy): string {
  return fingerprintOf(policy);
}

/** Whether progressing requires a clean review (no concerns accepted automatically, no unreviewed continuation). */
export function requiresCleanReview(policy: OrchestrationPolicy): boolean {
  return policy.review.enabled && policy.review.onConcerns === 'stop' && policy.review.onFailure === 'stop';
}

/** Human-readable policy summary, printed before every run and by dry-run/status. */
export function describePolicy(policy: OrchestrationPolicy): string[] {
  const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;
  const repairs =
    policy.repair.onValidationFailure || policy.repair.onBlockingReview
      ? `up to ${policy.repair.maxPerTask} per task, on ${[
          policy.repair.onValidationFailure ? 'failed validation' : null,
          policy.repair.onBlockingReview ? 'blocking review' : null,
        ]
          .filter((item) => item !== null)
          .join(' and ')}`
      : 'disabled';
  const review = policy.review.enabled
    ? `enabled (reviewer ${policy.review.reviewer}, ${seconds(policy.review.timeoutMs)}); concerns: ${policy.review.onConcerns === 'stop' ? 'stop for a human' : 'continue'}; review unavailable: ${policy.review.onFailure === 'stop' ? 'stop' : 'continue unreviewed'}`
    : 'disabled';
  const decision = policy.decision.enabled
    ? `ENABLED (decision-maker ${policy.decision.provider}, ${seconds(policy.decision.timeoutMs)}): judges reviews that would stop for a human; accept needs high confidence and evidence, otherwise escalates`
    : 'disabled (review decisions stop for a human)';
  return [
    `Implementer:   ${policy.worker} (${policy.access === 'edit' ? 'edit — MAY MODIFY FILES' : 'read-only'}, timeout ${seconds(policy.workerTimeoutMs)})`,
    `Max tasks:     ${policy.maxTasks}`,
    `Max steps:     ${policy.maxSteps}`,
    `Repairs:       ${repairs}`,
    `AI review:     ${review}`,
    `Clean review required: ${requiresCleanReview(policy) ? 'yes' : 'no'}`,
    `Auto-decision: ${decision}`,
    `Auto-commit:   ${policy.autoCommit ? 'enabled (local only, safe-commit rules; never pushes)' : 'disabled'}`,
    `Mode:          ${policy.autonomous ? 'AUTONOMOUS (recoverable events handled within budgets; hard stops unchanged)' : 'standard (recoverable events stop for a human unless a recovery budget is set)'}`,
    `Recovery:      ${describeRecovery(policy)}`,
    'Push:          never',
  ];
}

function describeRecovery(policy: OrchestrationPolicy): string {
  const r = policy.recovery;
  const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;
  const timeouts =
    r.timeoutRecoveries === 0
      ? 'timeout recovery off'
      : `timeout recovery ${r.timeoutRecoveries}/task (${Array.from({ length: r.timeoutRecoveries }, (_, index) => seconds(workerTimeoutFor(policy, index + 1))).join(' -> ')}, cap ${seconds(r.maxWorkerTimeoutMs)})`;
  const retries = r.providerRetries === 0 ? 'provider retries off' : `provider retries ${r.providerRetries} (backoff ${seconds(r.retryBackoffMs)} x n)`;
  const evidence = r.evidenceReviews === 0 ? 'evidence re-review off' : `evidence re-reviews ${r.evidenceReviews}/attempt`;
  return `${timeouts}; ${retries}; ${evidence}`;
}
