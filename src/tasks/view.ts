import { hostname } from 'node:os';

import type { MilestoneRecord, ProjectState, TaskAttempt, TaskRecord } from '../state/index.ts';

/**
 * Derived, read-only view of the workflow. Everything here is computed from
 * stored state (plus process liveness for interruption) and is never stored,
 * so it cannot drift from the records it describes. Ordering is always
 * milestone order, then task order.
 */

/**
 * What a task can do next:
 * - `ready`        pending, all dependencies succeeded: can run
 * - `waiting`      pending, some dependency has not succeeded yet
 * - `blocked`      pending, a dependency can never succeed (cancelled, exhausted, or itself blocked)
 * - `running`      an execution is in progress
 * - `interrupted`  recorded as running, but the executing Forge process is gone: needs `task recover`
 * - `awaiting-validation`  the worker invocation succeeded; accept or reject
 * - `retryable`    failed, attempts remain: can run again (explicitly)
 * - `exhausted`    failed, no attempts remain
 * - `succeeded` / `cancelled`  terminal
 */
export type TaskCondition =
  | 'ready'
  | 'waiting'
  | 'blocked'
  | 'running'
  | 'interrupted'
  | 'awaiting-validation'
  | 'retryable'
  | 'exhausted'
  | 'succeeded'
  | 'cancelled';

export const TASK_CONDITIONS: readonly TaskCondition[] = [
  'ready',
  'waiting',
  'blocked',
  'running',
  'interrupted',
  'awaiting-validation',
  'retryable',
  'exhausted',
  'succeeded',
  'cancelled',
];

export interface TaskView {
  readonly task: TaskRecord;
  readonly milestone: MilestoneRecord;
  /** Display key `<milestone order>.<task order>`, e.g. `1.2`. */
  readonly key: string;
  readonly condition: TaskCondition;
  /** True when `forge task run` may start it now. */
  readonly runnable: boolean;
  readonly attemptsUsed: number;
  readonly attemptsRemaining: number;
  /** Dependencies that have not succeeded (yet). */
  readonly unmetDependencies: readonly string[];
  /** Dependencies that can never succeed, making this task blocked. */
  readonly blockingDependencies: readonly string[];
  /** The last attempt ended in an integrity or scope violation; a retry must be acknowledged explicitly. */
  readonly requiresIntegrityAcknowledgement: boolean;
  readonly lastAttempt: TaskAttempt | undefined;
}

export interface MilestoneView {
  readonly milestone: MilestoneRecord;
  readonly tasks: readonly TaskView[];
  /** Completion rule: every task succeeded or cancelled, and at least one succeeded. */
  readonly canComplete: boolean;
  /** Some task is blocked or exhausted, so the milestone cannot complete without intervention. */
  readonly hasStuckTasks: boolean;
}

export interface WorkflowView {
  readonly milestones: readonly MilestoneView[];
  /** All tasks in deterministic order. */
  readonly tasks: readonly TaskView[];
  readonly runnable: readonly TaskView[];
  task(id: string): TaskView | undefined;
  milestone(id: string): MilestoneView | undefined;
}

/** Decides whether the Forge process that started an attempt is still executing it. */
export type ExecutorLiveness = (executor: TaskAttempt['executor']) => boolean;

/**
 * Default liveness: an executor on this machine is alive if its process
 * exists. Executors on other machines cannot be checked and are assumed
 * alive (recover them with `--force`).
 */
export const processLiveness: ExecutorLiveness = (executor) => {
  if (executor.host !== hostname()) {
    return true;
  }
  if (executor.pid === process.pid) {
    return true;
  }
  try {
    process.kill(executor.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export function deriveWorkflow(state: ProjectState, liveness: ExecutorLiveness = processLiveness): WorkflowView {
  const milestones = [...state.milestones].sort((a, b) => a.order - b.order);
  const taskById = new Map(state.tasks.map((task) => [task.id, task]));
  const conditions = new Map<string, TaskCondition>();

  // Dependencies form a DAG (validated on load), so this recursion terminates.
  const conditionOf = (id: string): TaskCondition => {
    const known = conditions.get(id);
    if (known !== undefined) {
      return known;
    }
    const task = taskById.get(id);
    const condition = task === undefined ? 'blocked' : computeCondition(task, conditionOf, liveness);
    conditions.set(id, condition);
    return condition;
  };

  const views: TaskView[] = [];
  for (const milestone of milestones) {
    const tasks = state.tasks.filter((task) => task.milestoneId === milestone.id).sort((a, b) => a.order - b.order);
    for (const task of tasks) {
      const condition = conditionOf(task.id);
      const dependencyConditions = task.dependsOn.map((id) => [id, conditionOf(id)] as const);
      const lastAttempt = task.attempts.at(-1);
      views.push({
        task,
        milestone,
        key: `${milestone.order}.${task.order}`,
        condition,
        runnable: condition === 'ready' || condition === 'retryable',
        attemptsUsed: task.attempts.length,
        attemptsRemaining: Math.max(0, task.maxAttempts - task.attempts.length),
        unmetDependencies: dependencyConditions.filter(([, c]) => c !== 'succeeded').map(([id]) => id),
        blockingDependencies: dependencyConditions.filter(([, c]) => isPermanentlyUnsatisfied(c)).map(([id]) => id),
        requiresIntegrityAcknowledgement:
          task.status === 'failed' && (lastAttempt?.outcome === 'integrity-violation' || lastAttempt?.outcome === 'scope-violation'),
        lastAttempt,
      });
    }
  }

  const milestoneViews = milestones.map((milestone): MilestoneView => {
    const tasks = views.filter((view) => view.milestone.id === milestone.id);
    return {
      milestone,
      tasks,
      canComplete:
        tasks.some((view) => view.task.status === 'succeeded') &&
        tasks.every((view) => view.task.status === 'succeeded' || view.task.status === 'cancelled'),
      hasStuckTasks: tasks.some((view) => view.condition === 'blocked' || view.condition === 'exhausted'),
    };
  });

  const viewById = new Map(views.map((view) => [view.task.id, view]));
  const milestoneViewById = new Map(milestoneViews.map((view) => [view.milestone.id, view]));
  return {
    milestones: milestoneViews,
    tasks: views,
    runnable: views.filter((view) => view.runnable),
    task: (id) => viewById.get(id),
    milestone: (id) => milestoneViewById.get(id),
  };
}

function computeCondition(
  task: TaskRecord,
  dependencyCondition: (id: string) => TaskCondition,
  liveness: ExecutorLiveness,
): TaskCondition {
  switch (task.status) {
    case 'succeeded':
    case 'cancelled':
    case 'awaiting-validation':
      return task.status;
    case 'running': {
      const last = task.attempts.at(-1);
      return last !== undefined && !liveness(last.executor) ? 'interrupted' : 'running';
    }
    case 'failed':
      // A failed task has run, so its dependencies had all succeeded (terminal).
      return task.attempts.length < task.maxAttempts ? 'retryable' : 'exhausted';
    case 'pending': {
      const dependencies = task.dependsOn.map(dependencyCondition);
      if (dependencies.some(isPermanentlyUnsatisfied)) {
        return 'blocked';
      }
      return dependencies.every((condition) => condition === 'succeeded') ? 'ready' : 'waiting';
    }
  }
}

function isPermanentlyUnsatisfied(condition: TaskCondition): boolean {
  return condition === 'cancelled' || condition === 'exhausted' || condition === 'blocked';
}
