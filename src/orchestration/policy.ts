import { createHash } from 'node:crypto';

import { ValidationError } from '../core/errors.ts';
import { SchemaViolation } from '../core/validation.ts';
import { ORCHESTRATION_LIMITS, decodeOrchestrationPolicy } from '../state/index.ts';
import type { OrchestrationPolicy, WorkerAccessMode } from '../state/index.ts';

/**
 * Orchestration policy: the complete, explicit list of what `forge run` may
 * do on its own. It is built only from Forge's conservative defaults plus
 * options a human passed on the command line; nothing an AI provider,
 * repository file, or validation output says can change it.
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
  if (repairOnBlockingReview && options.review !== true && options.reviewer === undefined) {
    throw new ValidationError('Review-driven repair requires AI review to be enabled (--review)');
  }
  const reviewEnabled = options.review === true || options.reviewer !== undefined;
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

export function describeLimits(): string {
  return `max tasks ${ORCHESTRATION_LIMITS.maxTasks}, max steps ${ORCHESTRATION_LIMITS.maxSteps}, max repairs per task ${ORCHESTRATION_LIMITS.maxRepairsPerTask}`;
}

/** SHA-256 over the policy with sorted keys, recorded with every run. */
export function policyHash(policy: OrchestrationPolicy): string {
  return createHash('sha256').update(canonicalJson(policy)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
  return [
    `Implementer:   ${policy.worker} (${policy.access === 'edit' ? 'edit — MAY MODIFY FILES' : 'read-only'}, timeout ${seconds(policy.workerTimeoutMs)})`,
    `Max tasks:     ${policy.maxTasks}`,
    `Max steps:     ${policy.maxSteps}`,
    `Repairs:       ${repairs}`,
    `AI review:     ${review}`,
    `Clean review required: ${requiresCleanReview(policy) ? 'yes' : 'no'}`,
    `Auto-commit:   ${policy.autoCommit ? 'enabled (local only, safe-commit rules; never pushes)' : 'disabled'}`,
    'Push:          never',
  ];
}
