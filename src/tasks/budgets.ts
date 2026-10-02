import { attemptsWithTrigger, implementationAttempts } from '../state/index.ts';
import type { OrchestrationPolicy, ProjectState, TaskRecord } from '../state/index.ts';

/**
 * How much of each bounded budget a task has used, derived from its stored
 * attempts and reviews (so it survives restarts and never double-counts).
 * The kinds are deliberately separate: a timeout continuation is not a
 * repair of completed work, and neither is a provider retry.
 */
export interface TaskBudgetUsage {
  /** Attempts that count against the task's `maxAttempts`. */
  readonly implementationAttempts: number;
  readonly maxAttempts: number;
  /** Implementation repairs; validation and review repairs share the policy's repair budget. */
  readonly validationRepairs: number;
  readonly reviewRepairs: number;
  /** Continuations of timed-out attempts. */
  readonly timeoutRecoveries: number;
  /** Retries after failed worker invocations. */
  readonly providerRetries: number;
  /** Reviews of this task's attempts with expanded evidence. */
  readonly evidenceReviews: number;
}

export function budgetUsage(state: ProjectState, task: TaskRecord): TaskBudgetUsage {
  return {
    implementationAttempts: implementationAttempts(task),
    maxAttempts: task.maxAttempts,
    validationRepairs: attemptsWithTrigger(task, 'validation'),
    reviewRepairs: attemptsWithTrigger(task, 'review'),
    timeoutRecoveries: attemptsWithTrigger(task, 'timeout'),
    providerRetries: attemptsWithTrigger(task, 'worker-failure'),
    evidenceReviews: state.taskReviews.filter((review) => review.taskId === task.id && review.evidenceRound > 0).length,
  };
}

/** One line per budget, with the policy's limits when known. */
export function describeBudgetUsage(usage: TaskBudgetUsage, policy: OrchestrationPolicy | null): string[] {
  const of = (limit: number | undefined): string => (limit === undefined ? '' : `/${limit}`);
  const repairs = usage.validationRepairs + usage.reviewRepairs;
  return [
    `implementation attempts ${usage.implementationAttempts}/${usage.maxAttempts}`,
    `repairs ${repairs}${of(policy?.repair.maxPerTask)} (validation ${usage.validationRepairs}, review ${usage.reviewRepairs})`,
    `timeout recoveries ${usage.timeoutRecoveries}${of(policy?.recovery.timeoutRecoveries)}`,
    `provider retries ${usage.providerRetries}${of(policy?.recovery.providerRetries)}`,
    `evidence re-reviews ${usage.evidenceReviews}${policy === null ? '' : ` (up to ${policy.recovery.evidenceReviews} per attempt)`}`,
  ];
}
