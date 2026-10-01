import { WorkflowError } from '../core/errors.ts';
import { decideReview } from '../review/index.ts';
import { AI_LIMITS } from '../state/index.ts';
import type { AiDecisionRecord, ProjectState, TaskReview } from '../state/index.ts';

/**
 * Pure state transitions for AI decisions. An AI decision is applied
 * through the SAME review-decision transition a human uses (`decideReview`
 * with `by: 'ai'`), in the same write as its record, so there is no
 * separate success path: acceptance only marks the review accepted, and
 * remediation reopens the task through the task state machine.
 */

/**
 * The review an AI decision may act on: the latest completed, undecided
 * review of the latest attempt of a succeeded task whose latest attempt
 * passed deterministic validation. Anything else is refused.
 */
export function decidableReview(state: ProjectState, taskId: string): TaskReview {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  const attempt = task?.attempts.at(-1);
  if (task === undefined || attempt === undefined || task.status !== 'succeeded' || attempt.outcome !== 'validated') {
    throw new WorkflowError('Only a succeeded task whose latest attempt passed deterministic validation can be decided');
  }
  const review = [...state.taskReviews]
    .reverse()
    .find((candidate) => candidate.taskId === taskId && candidate.attempt === attempt.number && ['clear', 'concerns', 'blocking-concerns'].includes(candidate.status));
  if (review === undefined) {
    throw new WorkflowError(`Task "${task.title}" has no completed review of its latest attempt to decide on`);
  }
  if (review.decision !== null) {
    throw new WorkflowError(`The latest review of task "${task.title}" was already decided (${review.decision.kind} by ${review.decision.by})`);
  }
  return review;
}

/**
 * Records the decision and applies its effect atomically. If the effect
 * cannot be applied (e.g. the task can no longer be reopened because
 * dependent work ran on it), the decision is recorded as escalated with the
 * reason, never applied partially. Returns the record as stored.
 */
export function applyAiDecision(state: ProjectState, record: AiDecisionRecord, now: Date): { readonly state: ProjectState; readonly record: AiDecisionRecord } {
  const review = decidableReview(state, record.taskId);
  if (review.id !== record.reviewId || review.attempt !== record.attempt) {
    throw new WorkflowError('The review changed while the decision-maker was deciding; nothing was recorded');
  }
  if (record.effect === 'escalated') {
    return { state: withDecision(state, record), record };
  }
  const reason = clip(`AI decision-maker (${record.call.provider}, confidence ${record.confidence}): ${record.reason ?? ''}`, AI_LIMITS.reason);
  try {
    const next =
      record.effect === 'accepted'
        ? decideReview(withDecision(state, record), record.taskId, 'accepted', reason, now, 'ai', { aiDecisionId: record.id })
        : decideReview(withDecision(state, record), record.taskId, 'remediation-required', reason, now, 'ai', {
            aiDecisionId: record.id,
            requirements: record.requiredActions,
          });
    return { state: next, record };
  } catch (error) {
    if (!(error instanceof WorkflowError)) {
      throw error;
    }
    const escalated: AiDecisionRecord = { ...record, effect: 'escalated', policyNote: clip(`the ${record.effect} could not be applied: ${error.message}`, AI_LIMITS.decisionReason) };
    return { state: withDecision(state, escalated), record: escalated };
  }
}

/** Number of decision attempts already made on a review (bounded per review). */
export function decisionsForReview(state: ProjectState, reviewId: string): AiDecisionRecord[] {
  return state.aiDecisions.filter((decision) => decision.reviewId === reviewId);
}

/** Adds the record; beyond the per-task bound the oldest escalated (never applied) decision of the task is dropped. */
function withDecision(state: ProjectState, record: AiDecisionRecord): ProjectState {
  let decisions = [...state.aiDecisions, record];
  const forTask = decisions.filter((decision) => decision.taskId === record.taskId);
  if (forTask.length > AI_LIMITS.aiDecisionsPerTask) {
    const drop = forTask.find((decision) => decision.effect === 'escalated' && decision.id !== record.id);
    if (drop === undefined) {
      throw new WorkflowError(`Task already has ${AI_LIMITS.aiDecisionsPerTask} applied AI decisions`);
    }
    decisions = decisions.filter((decision) => decision.id !== drop.id);
  }
  return { ...state, aiDecisions: decisions };
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
