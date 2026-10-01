import { WorkflowError } from '../core/errors.ts';
import { AI_LIMITS } from '../state/index.ts';
import type { ProjectState, ReviewDecider, ReviewDecisionKind, TaskReview } from '../state/index.ts';
import { reopenForRemediation } from '../tasks/index.ts';

/**
 * Pure state transitions for reviews. Recording a review never changes a
 * task; only an explicit human decision can, and only `remediation-required`
 * (which reopens the task through the task state machine).
 */

export function recordReview(state: ProjectState, review: TaskReview): ProjectState {
  let reviews = [...state.taskReviews, review];
  const forTask = reviews.filter((candidate) => candidate.taskId === review.taskId);
  if (forTask.length > AI_LIMITS.reviewsPerTask) {
    // Drop the oldest undecided review of this task; decided ones are an audit trail.
    const drop = forTask.find((candidate) => candidate.decision === null && candidate.id !== review.id);
    if (drop === undefined) {
      throw new WorkflowError(`Task already has ${AI_LIMITS.reviewsPerTask} decided reviews`);
    }
    reviews = reviews.filter((candidate) => candidate.id !== drop.id);
  }
  return { ...state, taskReviews: reviews };
}

/**
 * Records a decision (a human's, or Forge applying an explicit orchestration
 * policy — never the reviewer's) on the latest completed review of the task's
 * latest attempt. `remediation-required` also reopens the task (its
 * validation evidence is kept); `accepted` changes nothing else.
 */
export function decideReview(
  state: ProjectState,
  taskId: string,
  kind: ReviewDecisionKind,
  reason: string,
  now: Date,
  by: ReviewDecider = 'human',
): ProjectState {
  const text = reason.trim();
  if (text === '' || text.length > AI_LIMITS.reason) {
    throw new WorkflowError(`A reason of 1-${AI_LIMITS.reason} characters is required`);
  }
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  const attempt = task?.attempts.at(-1);
  if (task === undefined || attempt === undefined) {
    throw new WorkflowError('The task has no attempts to decide on');
  }
  const review = [...state.taskReviews]
    .reverse()
    .find((candidate) => candidate.taskId === taskId && candidate.attempt === attempt.number && ['clear', 'concerns', 'blocking-concerns'].includes(candidate.status));
  if (review === undefined) {
    throw new WorkflowError(`Task "${task.title}" has no completed review of its latest attempt; run \`forge task review\` first`);
  }
  if (review.decision !== null) {
    throw new WorkflowError(`The latest review was already decided (${review.decision.kind})`);
  }
  const decided: TaskReview = { ...review, decision: { kind, reason: text, decidedAt: now.toISOString(), by } };
  const next = { ...state, taskReviews: state.taskReviews.map((candidate) => (candidate.id === review.id ? decided : candidate)) };
  return kind === 'remediation-required' ? reopenForRemediation(next, taskId, attempt.number, text, now) : next;
}
