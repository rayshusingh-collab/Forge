import { SchemaViolation } from '../core/validation.ts';
import { describeDependencyProblem, findDependencyProblem } from './graph.ts';
import { AI_LIMITS } from './model.ts';
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
  'validation-failed',
  'scope-violation',
  'review-rejected',
];

/** Attempt outcomes that make a task succeeded. `accepted` exists only in Milestone 4 state. */
export const SUCCEEDED_ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = ['validated', 'overridden', 'accepted'];

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
    case 'validated':
    case 'overridden':
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
    case 'validated':
    case 'validation-failed':
    case 'overridden':
    case 'scope-violation':
    case 'review-rejected':
      // Validation and scope verdicts come after a worker invocation that succeeded.
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

  checkPlanProposals(state, milestoneIds, taskIds);
  checkTaskReviews(state);
  checkRepairs(state);
  checkOrchestrationRuns(state);
  checkApprovals(state, taskIds);
  uniqueIds(state.controlEvents, 'controlEvents');
}

/**
 * Approvals reference real tasks, and at most one open (pending or approved)
 * approval exists per type and subject, so a decision is never ambiguous.
 */
function checkApprovals(state: ProjectState, taskIds: ReadonlySet<string>): void {
  uniqueIds(state.approvals, 'approvals');
  const open = new Set<string>();
  state.approvals.forEach((approval, index) => {
    if (approval.taskId !== null && !taskIds.has(approval.taskId)) {
      throw new SchemaViolation(`approvals[${index}].taskId`, `references unknown task "${approval.taskId}"`);
    }
    if ((approval.type === 'lease-recovery') !== (approval.taskId === null)) {
      throw new SchemaViolation(`approvals[${index}].taskId`, 'must be null exactly for lease recovery');
    }
    if (approval.status === 'pending' || approval.status === 'approved') {
      const subject = `${approval.type}#${approval.taskId ?? approval.runId ?? '-'}`;
      if (open.has(subject)) {
        throw new SchemaViolation(`approvals[${index}]`, 'is a second open approval for the same type and subject');
      }
      open.add(subject);
    }
  });
}

/**
 * A repair attempt must follow directly from the attempt whose evidence
 * triggered it: failed validation, or a review-driven remediation decision
 * on a recorded review. Repair numbers count up by one per task.
 */
function checkRepairs(state: ProjectState): void {
  const reviews = new Map(state.taskReviews.map((review) => [review.id, review]));
  for (const [taskIndex, task] of state.tasks.entries()) {
    let repairs = 0;
    for (const [index, attempt] of task.attempts.entries()) {
      const repair = attempt.origin?.repair ?? null;
      if (repair === null) {
        continue;
      }
      const path = `tasks[${taskIndex}].attempts[${index}].origin.repair`;
      repairs += 1;
      if (repair.number !== repairs) {
        throw new SchemaViolation(`${path}.number`, `must be ${repairs} (repairs are counted per task)`);
      }
      const source = task.attempts[repair.fromAttempt - 1];
      if (repair.fromAttempt !== attempt.number - 1 || source === undefined) {
        throw new SchemaViolation(`${path}.fromAttempt`, 'must be the previous attempt');
      }
      const expected = repair.trigger === 'validation' ? 'validation-failed' : 'review-rejected';
      if (source.outcome !== expected) {
        throw new SchemaViolation(`${path}.trigger`, `"${repair.trigger}" requires the previous attempt to be ${expected}`);
      }
      if (repair.reviewId !== null) {
        const review = reviews.get(repair.reviewId);
        if (review !== undefined && (review.taskId !== task.id || review.attempt !== repair.fromAttempt)) {
          throw new SchemaViolation(`${path}.reviewId`, 'refers to a review of a different task or attempt');
        }
      }
    }
  }
}

/** Run IDs are unique and, thanks to the orchestration lease, at most one run is in progress. */
function checkOrchestrationRuns(state: ProjectState): void {
  uniqueIds(state.orchestrationRuns, 'orchestrationRuns');
  if (state.orchestrationRuns.filter((run) => run.status === 'running').length > 1) {
    throw new SchemaViolation('orchestrationRuns', 'contain more than one running orchestration run');
  }
}

/** Proposal status must match its decision fields; applied mappings must point at real work. */
function checkPlanProposals(state: ProjectState, milestoneIds: ReadonlySet<string>, taskIds: ReadonlySet<string>): void {
  uniqueIds(state.planProposals, 'planProposals');
  state.planProposals.forEach((proposal, index) => {
    const path = `planProposals[${index}]`;
    const mapped = proposal.appliedMilestones.length + proposal.appliedTasks.length > 0;
    switch (proposal.status) {
      case 'proposed':
        if (proposal.decidedAt !== null || proposal.reason !== null || mapped) {
          throw new SchemaViolation(path, 'is proposed but carries a decision');
        }
        break;
      case 'rejected':
        if (proposal.decidedAt === null || proposal.reason === null || mapped) {
          throw new SchemaViolation(path, 'is rejected but lacks a reason or has applied work');
        }
        break;
      case 'applied': {
        const complete =
          proposal.decidedAt !== null &&
          sameIds(proposal.appliedMilestones.map((m) => m.proposalId), proposal.plan.milestones.map((m) => m.id)) &&
          sameIds(proposal.appliedTasks.map((t) => t.proposalId), proposal.plan.tasks.map((t) => t.id));
        if (!complete) {
          throw new SchemaViolation(path, 'is applied but its mapping does not cover the plan');
        }
        for (const mapping of proposal.appliedMilestones) {
          if (!milestoneIds.has(mapping.forgeId)) {
            throw new SchemaViolation(`${path}.appliedMilestones`, `references unknown milestone "${mapping.forgeId}"`);
          }
        }
        for (const mapping of proposal.appliedTasks) {
          if (!taskIds.has(mapping.forgeId)) {
            throw new SchemaViolation(`${path}.appliedTasks`, `references unknown task "${mapping.forgeId}"`);
          }
        }
        break;
      }
    }
  });
}

/**
 * Reviews must reference real attempts; decisions only follow a completed
 * review; a `remediation-required` decision and a `review-rejected` attempt
 * always appear together.
 */
function checkTaskReviews(state: ProjectState): void {
  uniqueIds(state.taskReviews, 'taskReviews');
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  const perTask = new Map<string, number>();
  const remediated = new Set<string>();
  state.taskReviews.forEach((review, index) => {
    const path = `taskReviews[${index}]`;
    const task = tasks.get(review.taskId);
    if (task === undefined) {
      throw new SchemaViolation(`${path}.taskId`, `references unknown task "${review.taskId}"`);
    }
    const attempt = task.attempts[review.attempt - 1];
    if (attempt === undefined) {
      throw new SchemaViolation(`${path}.attempt`, `references attempt ${review.attempt}, which does not exist`);
    }
    perTask.set(review.taskId, (perTask.get(review.taskId) ?? 0) + 1);
    const completed = review.status === 'clear' || review.status === 'concerns' || review.status === 'blocking-concerns';
    if (review.decision !== null && !completed) {
      throw new SchemaViolation(`${path}.decision`, 'is only allowed on a completed review');
    }
    if (review.decision?.kind === 'remediation-required') {
      if (attempt.outcome !== 'review-rejected') {
        throw new SchemaViolation(`${path}.decision`, 'requires remediation, but the attempt was not reopened');
      }
      remediated.add(`${review.taskId}#${review.attempt}`);
    }
  });
  for (const [taskId, count] of perTask) {
    if (count > AI_LIMITS.reviewsPerTask) {
      throw new SchemaViolation('taskReviews', `contain more than ${AI_LIMITS.reviewsPerTask} reviews for task "${taskId}"`);
    }
  }
  for (const task of state.tasks) {
    task.attempts.forEach((attempt) => {
      if (attempt.outcome === 'review-rejected' && !remediated.has(`${task.id}#${attempt.number}`)) {
        throw new SchemaViolation(`tasks`, `attempt ${attempt.number} of "${task.id}" is review-rejected without a recorded review decision`);
      }
    });
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
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

  if (task.humanRepair !== null) {
    checkHumanRepair(task, `${path}.humanRepair`);
  }
  // An accepted human repair is the only way a task succeeds after its attempts all failed.
  const implied = task.humanRepair === null ? statusImpliedByAttempts(task.attempts) : 'succeeded';
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

/**
 * A human repair is accepted only for an exhausted task whose attempts all
 * failed, after required validation passed; its record must say exactly that.
 */
function checkHumanRepair(task: TaskRecord, path: string): void {
  const repair = task.humanRepair!;
  const last = task.attempts.at(-1);
  if (last === undefined || task.attempts.length < task.maxAttempts || repair.afterAttempt !== last.number) {
    throw new SchemaViolation(`${path}.afterAttempt`, 'must be the last attempt of a task that used all its attempts');
  }
  if (!FAILED_ATTEMPT_OUTCOMES.includes(last.outcome)) {
    throw new SchemaViolation(`${path}.afterAttempt`, `follows attempt outcome "${last.outcome}", but only a failed task can be repaired by a human`);
  }
  if (repair.validation.status !== 'passed' || !repair.validation.checks.some((check) => check.required && check.status === 'passed')) {
    throw new SchemaViolation(`${path}.validation`, 'must be a passed validation of at least one required check');
  }
  if (repair.acknowledgedViolation !== (last.outcome === 'integrity-violation' || last.outcome === 'scope-violation')) {
    throw new SchemaViolation(`${path}.acknowledgedViolation`, 'must be set exactly when the last attempt ended in an integrity or scope violation');
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
