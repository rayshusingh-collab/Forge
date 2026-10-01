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
}

/**
 * Conditions that always stop a run, whatever the policy says. Listed so
 * the user sees them before an autonomous run starts.
 */
export const ALWAYS_STOP_CONDITIONS: readonly string[] = [
  'integrity or scope violation (never acknowledged automatically)',
  'interrupted or concurrently running task',
  'task awaiting manual validation (validation is never overridden automatically)',
  'failed worker invocation, or repair budget / attempts exhausted',
  'unresolved merge conflicts or other unsafe Git state',
  'AI decision-maker escalation, low confidence, malformed output, or unavailability (never treated as acceptance)',
  'commit refused by the safe-commit rules (e.g. mixed attribution)',
  'provider unavailable when no safe continuation exists',
  'workflow complete, limit reached, or Ctrl+C',
];

export function buildPolicy(options: PolicyOptions, defaults: { readonly workerTimeoutMs: number }): OrchestrationPolicy {
  const repairOnValidationFailure = options.repairOnValidationFailure ?? false;
  const repairOnBlockingReview = options.repairOnBlockingReview ?? false;
  const maxPerTask = options.maxRepairsPerTask ?? POLICY_DEFAULTS.maxRepairsPerTask;
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
    workerTimeoutMs: options.workerTimeoutMs ?? defaults.workerTimeoutMs,
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
  return `max tasks ${ORCHESTRATION_LIMITS.maxTasks}, max steps ${ORCHESTRATION_LIMITS.maxSteps}, max repairs per task ${ORCHESTRATION_LIMITS.maxRepairsPerTask}`;
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
    'Push:          never',
  ];
}
