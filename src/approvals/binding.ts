import { fingerprintOf, sha256Hex } from '../core/fingerprint.ts';
import type { ApprovalType, ProjectState } from '../state/index.ts';

/**
 * What an approval is bound to. The fingerprint covers exactly the
 * evidence a human looked at; if any of it changes (a new attempt, a new
 * review, a decision, a different lock file), the fingerprint changes and
 * the approval can no longer be used.
 */

export interface ApprovalBinding {
  readonly fingerprint: string;
  /** Short human-readable description of what the fingerprint covers. */
  readonly boundTo: string;
}

/** Binding for a task-scoped approval, computed from state alone; null if the task does not exist. */
export function taskApprovalBinding(state: ProjectState, type: Exclude<ApprovalType, 'lease-recovery'>, taskId: string): ApprovalBinding | null {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    return null;
  }
  const last = task.attempts.at(-1);
  const base = {
    type,
    taskId,
    status: task.status,
    attempts: task.attempts.length,
    maxAttempts: task.maxAttempts,
    lastOutcome: last?.outcome ?? null,
    lastRunId: last?.runId ?? null,
  };
  const attemptText = last === undefined ? 'no attempts' : `attempt ${last.number} (${last.outcome}, run ${last.runId.slice(0, 8)})`;
  switch (type) {
    case 'review-acceptance': {
      const review = last === undefined ? undefined : [...state.taskReviews].reverse().find((candidate) => candidate.taskId === taskId && candidate.attempt === last.number);
      return {
        fingerprint: fingerprintOf({ ...base, review: review === undefined ? null : { id: review.id, status: review.status, decision: review.decision?.kind ?? null } }),
        boundTo: `task ${taskId.slice(0, 8)} ${attemptText}; review ${review?.id.slice(0, 8) ?? 'none'} (${review?.status ?? '-'})`,
      };
    }
    case 'interrupted-recovery':
      return {
        fingerprint: fingerprintOf({ ...base, executor: last?.executor ?? null, startedAt: last?.startedAt ?? null }),
        boundTo: `task ${taskId.slice(0, 8)} ${attemptText}${last === undefined ? '' : `, executor pid ${last.executor.pid} on ${last.executor.host}`}`,
      };
    default:
      return { fingerprint: fingerprintOf(base), boundTo: `task ${taskId.slice(0, 8)} ${attemptText}` };
  }
}

/** Binding for a forced lease recovery: the exact bytes of the lock file (including its owner token). */
export function leaseApprovalBinding(lockContent: string, description: string): ApprovalBinding {
  return { fingerprint: sha256Hex(`lease-recovery\n${lockContent}`), boundTo: description };
}
