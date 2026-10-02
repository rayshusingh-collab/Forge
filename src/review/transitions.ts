import { WorkflowError } from '../core/errors.ts';
import { AI_LIMITS, remediationIdFor } from '../state/index.ts';
import type { ProjectState, RemediationRecord, ReviewDecider, ReviewDecisionKind, TaskReview } from '../state/index.ts';
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

export interface ReviewDecisionExtras {
  /** Structured remediation (defaults to the reason itself). Only for `remediation-required`. */
  readonly requirements?: readonly string[];
  /** Required exactly when `by` is `ai`: the AI decision being applied. */
  readonly aiDecisionId?: string;
  /** A human decision made through a review-acceptance approval: that approval. */
  readonly approvalId?: string;
}

/**
 * Records a decision (a human's, Forge applying an explicit orchestration
 * policy, or the AI decision-maker in an auto-decision run — never the
 * reviewer's) on the latest completed review of the task's latest attempt.
 *
 * - `remediation-required` reopens the task (its validation evidence is
 *   kept) and records a structured remediation that stays open until a
 *   later attempt's review is accepted.
 * - `accepted` satisfies the task's open remediations from earlier attempts
 *   and changes nothing else.
 */
export function decideReview(
  state: ProjectState,
  taskId: string,
  kind: ReviewDecisionKind,
  reason: string,
  now: Date,
  by: ReviewDecider = 'human',
  extras: ReviewDecisionExtras = {},
): ProjectState {
  if ((by === 'ai') !== (extras.aiDecisionId !== undefined)) {
    throw new WorkflowError('An AI review decision must reference its AI decision record (and only an AI decision may)');
  }
  if (extras.approvalId !== undefined && by !== 'human') {
    throw new WorkflowError('Only a human decision can come through an approval');
  }
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
  const decided: TaskReview = { ...review, decision: { kind, reason: text, decidedAt: now.toISOString(), by, aiDecisionId: extras.aiDecisionId ?? null, approvalId: extras.approvalId ?? null } };
  const next = { ...state, taskReviews: state.taskReviews.map((candidate) => (candidate.id === review.id ? decided : candidate)) };
  if (kind === 'accepted') {
    return satisfyRemediations(next, taskId, attempt.number, review.id, now);
  }
  const requirements = (extras.requirements ?? [text]).map((item) => item.trim()).filter((item) => item !== '');
  if (requirements.length === 0 || requirements.length > AI_LIMITS.remediationRequirements || requirements.some((item) => item.length > AI_LIMITS.requirementText)) {
    throw new WorkflowError(`Remediation needs 1-${AI_LIMITS.remediationRequirements} requirements of at most ${AI_LIMITS.requirementText} characters`);
  }
  const remediation: RemediationRecord = {
    id: remediationIdFor(review.id),
    taskId,
    fromAttempt: attempt.number,
    reviewId: review.id,
    source: by,
    requirements,
    createdAt: now.toISOString(),
    status: 'open',
    resolvedAt: null,
    resolvedByReviewId: null,
  };
  return reopenForRemediation({ ...next, remediations: [...next.remediations, remediation] }, taskId, attempt.number, text, now);
}

/** The task's remediations still waiting for a later attempt to be accepted, oldest first. */
export function openRemediations(state: ProjectState, taskId: string): RemediationRecord[] {
  return state.remediations.filter((remediation) => remediation.taskId === taskId && remediation.status === 'open');
}

/** Acceptance of a later attempt's review resolves every earlier open remediation of the task. */
function satisfyRemediations(state: ProjectState, taskId: string, attempt: number, reviewId: string, now: Date): ProjectState {
  return {
    ...state,
    remediations: state.remediations.map((remediation) =>
      remediation.taskId === taskId && remediation.status === 'open' && remediation.fromAttempt < attempt
        ? { ...remediation, status: 'satisfied', resolvedAt: now.toISOString(), resolvedByReviewId: reviewId }
        : remediation,
    ),
  };
}
