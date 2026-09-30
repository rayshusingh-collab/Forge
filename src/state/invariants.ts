import { SchemaViolation } from '../core/validation.ts';
import { describeDependencyProblem, findDependencyProblem } from './graph.ts';
import type { AttemptOutcome, ProjectState, TaskAttempt, TaskRecord, TaskStatus, WorkerRunRecord, WorkerRunStatus } from './model.ts';

/**
 * Cross-record rules for project state. They are checked on every load and
 * before every write, so neither hand-edited files nor a Forge bug can
 * persist an inconsistent workflow.
 */

/** Attempt outcomes that end an attempt without a successful invocation, or with a rejection. */
export const FAILED_ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  'rejected',
  'failed',
  'timeout',
  'cancelled',
  'unavailable',
  'invalid-output',
  'integrity-violation',
  'interrupted',
];

/** The task status implied by its latest attempt (ignoring cancellation). */
export function statusImpliedByAttempts(attempts: readonly TaskAttempt[]): TaskStatus {
  const last = attempts.at(-1);
  if (last === undefined) {
    return 'pending';
  }
  switch (last.outcome) {
    case 'running':
      return 'running';
    case 'awaiting-validation':
      return 'awaiting-validation';
    case 'accepted':
      return 'succeeded';
    default:
      return 'failed';
  }
}

/** The worker run status an attempt outcome requires on its linked run. */
export function runStatusForAttempt(outcome: AttemptOutcome): WorkerRunStatus {
  switch (outcome) {
    case 'awaiting-validation':
    case 'accepted':
    case 'rejected':
      return 'success';
    default:
      return outcome;
  }
}

export function checkWorkflowInvariants(state: ProjectState): void {
  const milestoneIds = uniqueIds(state.milestones, 'milestones');
  const taskIds = uniqueIds(state.tasks, 'tasks');
  uniqueIds(state.decisions, 'decisions');
  uniqueIds(state.workerRuns, 'workerRuns');

  uniqueValues(state.milestones.map((milestone) => milestone.order), 'milestones', 'order');
  const tasksByMilestone = new Map<string, TaskRecord[]>();
  state.tasks.forEach((task, index) => {
    if (!milestoneIds.has(task.milestoneId)) {
      throw new SchemaViolation(`tasks[${index}].milestoneId`, `references unknown milestone "${task.milestoneId}"`);
    }
    tasksByMilestone.set(task.milestoneId, [...(tasksByMilestone.get(task.milestoneId) ?? []), task]);
  });
  for (const [milestoneId, tasks] of tasksByMilestone) {
    uniqueValues(tasks.map((task) => task.order), `tasks of milestone "${milestoneId}"`, 'order');
  }

  const problem = findDependencyProblem(state.tasks);
  if (problem !== null) {
    throw new SchemaViolation('tasks', `have an invalid dependency graph: ${describeDependencyProblem(problem)}`);
  }

  const runsById = new Map(state.workerRuns.map((run) => [run.id, run]));
  const linkedRuns = new Set<string>();
  const statusById = new Map(state.tasks.map((task) => [task.id, task.status]));
  state.tasks.forEach((task, index) => {
    checkTask(task, `tasks[${index}]`, runsById, linkedRuns, statusById);
  });
  state.workerRuns.forEach((run, index) => {
    if (run.trigger === 'task' && !linkedRuns.has(run.id)) {
      throw new SchemaViolation(`workerRuns[${index}]`, 'is a task run that no task attempt refers to');
    }
  });

  state.milestones.forEach((milestone, index) => {
    const tasks = tasksByMilestone.get(milestone.id) ?? [];
    const path = `milestones[${index}].status`;
    if (milestone.status === 'pending' && tasks.some((task) => task.attempts.length > 0)) {
      throw new SchemaViolation(path, 'cannot be pending while one of its tasks has been executed');
    }
    if (milestone.status === 'completed') {
      const unfinished = tasks.some((task) => task.status !== 'succeeded' && task.status !== 'cancelled');
      if (unfinished || !tasks.some((task) => task.status === 'succeeded')) {
        throw new SchemaViolation(path, 'cannot be completed unless all tasks are succeeded or cancelled and at least one succeeded');
      }
    }
    if (milestone.status === 'cancelled' && tasks.some((task) => task.status !== 'succeeded' && task.status !== 'cancelled')) {
      throw new SchemaViolation(path, 'cannot be cancelled while it has unfinished tasks');
    }
  });

  state.decisions.forEach((decision, index) => {
    if (decision.taskId !== null && !taskIds.has(decision.taskId)) {
      throw new SchemaViolation(`decisions[${index}].taskId`, `references unknown task "${decision.taskId}"`);
    }
  });
}

function checkTask(
  task: TaskRecord,
  path: string,
  runsById: ReadonlyMap<string, WorkerRunRecord>,
  linkedRuns: Set<string>,
  statusById: ReadonlyMap<string, TaskStatus>,
): void {
  if (task.attempts.length > task.maxAttempts) {
    throw new SchemaViolation(`${path}.attempts`, `exceed maxAttempts (${task.maxAttempts})`);
  }
  task.attempts.forEach((attempt, index) => {
    const attemptPath = `${path}.attempts[${index}]`;
    if (attempt.number !== index + 1) {
      throw new SchemaViolation(`${attemptPath}.number`, `must be ${index + 1} (attempts are sequential)`);
    }
    const isLast = index === task.attempts.length - 1;
    if (!isLast && !FAILED_ATTEMPT_OUTCOMES.includes(attempt.outcome)) {
      throw new SchemaViolation(`${attemptPath}.outcome`, 'only the latest attempt may be unfinished or successful');
    }
    const run = runsById.get(attempt.runId);
    if (run === undefined) {
      throw new SchemaViolation(`${attemptPath}.runId`, `references unknown worker run "${attempt.runId}"`);
    }
    if (run.trigger !== 'task' || run.taskId !== task.id || run.attempt !== attempt.number) {
      throw new SchemaViolation(`${attemptPath}.runId`, 'refers to a worker run for a different task or attempt');
    }
    if (linkedRuns.has(run.id)) {
      throw new SchemaViolation(`${attemptPath}.runId`, 'refers to a worker run already used by another attempt');
    }
    linkedRuns.add(run.id);
    if (run.status !== runStatusForAttempt(attempt.outcome)) {
      throw new SchemaViolation(`${attemptPath}.outcome`, `"${attempt.outcome}" is inconsistent with its run status "${run.status}"`);
    }
  });

  const implied = statusImpliedByAttempts(task.attempts);
  if (task.status === 'cancelled') {
    if (implied !== 'pending' && implied !== 'failed') {
      throw new SchemaViolation(`${path}.status`, 'cannot be cancelled while its latest attempt is unfinished or successful');
    }
  } else if (task.status !== implied) {
    throw new SchemaViolation(`${path}.status`, `"${task.status}" is inconsistent with its attempts (expected "${implied}")`);
  }
  if (task.cancelReason !== null && task.status !== 'cancelled') {
    throw new SchemaViolation(`${path}.cancelReason`, 'must be null unless the task is cancelled');
  }
  // A task can only have been executed once all of its dependencies succeeded, and succeeded tasks are terminal.
  if (task.attempts.length > 0 && task.dependsOn.some((id) => statusById.get(id) !== 'succeeded')) {
    throw new SchemaViolation(`${path}.dependsOn`, 'includes a task that has not succeeded, but this task has been executed');
  }
}

function uniqueIds(records: readonly { readonly id: string }[], path: string): Set<string> {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    if (seen.has(record.id)) {
      throw new SchemaViolation(`${path}[${index}].id`, `duplicates "${record.id}"`);
    }
    seen.add(record.id);
  });
  return seen;
}

function uniqueValues(values: readonly number[], path: string, field: string): void {
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new SchemaViolation(path, `have duplicate ${field} ${value}`);
    }
    seen.add(value);
  }
}
