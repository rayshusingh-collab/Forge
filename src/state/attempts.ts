import { RECOVERY_TRIGGERS } from './model.ts';
import type { RepairTrigger, TaskAttempt, TaskRecord } from './model.ts';

/**
 * How a task's attempts divide into budgets. Derived only from the stored
 * attempts (their orchestration origin), so every counter survives restarts
 * and can never be double-counted.
 *
 * - implementation attempts: the first attempt, every manual attempt, and
 *   every implementation repair (validation or review) — bounded by the
 *   task's `maxAttempts`;
 * - implementation repairs: attempts repairing completed work, by trigger
 *   (`validation`, `review`) — the shared repair budget;
 * - recovery attempts: continuations of an unfinished attempt, by trigger
 *   (`timeout`, `worker-failure`) — each bounded by its own recovery budget,
 *   and NOT counted as implementation attempts.
 */

export function isRecoveryTrigger(trigger: RepairTrigger): boolean {
  return RECOVERY_TRIGGERS.includes(trigger);
}

export function isRecoveryAttempt(attempt: TaskAttempt): boolean {
  const repair = attempt.origin?.repair ?? null;
  return repair !== null && isRecoveryTrigger(repair.trigger);
}

/** Attempts that count against `maxAttempts`. */
export function implementationAttempts(task: TaskRecord): number {
  return task.attempts.filter((attempt) => !isRecoveryAttempt(attempt)).length;
}

/** Attempts started with the given trigger. */
export function attemptsWithTrigger(task: TaskRecord, trigger: RepairTrigger): number {
  return task.attempts.filter((attempt) => attempt.origin?.repair?.trigger === trigger).length;
}

/** The number a new attempt with this trigger gets: implementation repairs share one sequence, each recovery kind has its own. */
export function nextRepairNumber(task: TaskRecord, trigger: RepairTrigger): number {
  return (isRecoveryTrigger(trigger) ? attemptsWithTrigger(task, trigger) : attemptsWithTrigger(task, 'validation') + attemptsWithTrigger(task, 'review')) + 1;
}
