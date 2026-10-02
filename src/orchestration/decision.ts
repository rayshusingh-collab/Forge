import { AI_LIMITS, ORCHESTRATION_LIMITS, RECOVERABLE_OUTCOMES, attemptsWithTrigger } from '../state/index.ts';
import type { AiDecisionRecord, ApprovalType, OrchestrationPolicy, ProjectState, RepairTrigger, StopReason, TaskReview } from '../state/index.ts';
import { taskApprovalBinding } from '../approvals/index.ts';
import { commitEligibility, partialWorkProblem, repairsUsed } from '../tasks/index.ts';
import type { TaskView, WorkflowView } from '../tasks/index.ts';

/**
 * The orchestrator's decision function: given the persisted workflow state,
 * the explicit policy, and what this run has already done, it returns the
 * ONE next action. It is pure and deterministic (same inputs, same answer),
 * so dry-run, status, and the real loop agree by construction.
 *
 * It looks only at Forge's own records: task statuses, deterministic
 * validation outcomes, Forge-derived review statuses, and recorded
 * decisions. It never reads worker summaries, review prose, or anything
 * from the repository.
 *
 * Order of precedence:
 *   1. unsafe or human-owned conditions anywhere (interrupted, running,
 *      awaiting manual validation) stop the run;
 *   2. follow-up of work this orchestration produced (or any validated
 *      attempt answering an open remediation): review, AI decision when
 *      auto-decision is enabled, then commit (orchestrated work only);
 *   3. completing a milestone the existing rules say is complete;
 *   4. the first runnable task in milestone/task order (or a failed task
 *      whose unfinished attempt may be recovered): execute it, repair it when
 *      policy permits and budget remains, or recover a timed-out / failed
 *      worker attempt within the recovery budgets;
 *   5. otherwise explain why nothing can run (complete vs blocked vs ...).
 */

export type NextAction =
  | { readonly kind: 'execute'; readonly taskId: string }
  | {
      readonly kind: 'repair';
      readonly taskId: string;
      /** `timeout` / `worker-failure` are recovery continuations, not implementation repairs. */
      readonly trigger: RepairTrigger;
      readonly fromAttempt: number;
      readonly reviewId: string | null;
      /** A succeeded task must first be reopened by a policy review decision. */
      readonly reopen: boolean;
      /** Wait this long first (a provider retry's backoff). */
      readonly backoffMs?: number;
    }
  | {
      readonly kind: 'review';
      readonly taskId: string;
      readonly attempt: number;
      /** 0 for a normal review; N for the Nth evidence-expansion round. */
      readonly evidenceRound: number;
      /** `retry`: the previous review of this attempt failed; `expand`: re-review with more evidence. */
      readonly purpose: 'review' | 'retry' | 'expand';
      readonly backoffMs?: number;
    }
  | {
      readonly kind: 'decide';
      readonly taskId: string;
      readonly attempt: number;
      readonly reviewId: string;
      /** The previous decision attempt on this review gave no usable answer. */
      readonly retry: boolean;
      readonly backoffMs?: number;
    }
  | { readonly kind: 'commit'; readonly taskId: string; readonly attempt: number }
  | { readonly kind: 'complete-milestone'; readonly milestoneId: string }
  | {
      readonly kind: 'apply-approval';
      readonly approvalId: string;
      readonly approvalType: ApprovalType;
      readonly taskId: string;
      /**
       * How the human resolved it. Normally only an approval is applied; a REJECTED
       * review-acceptance request is applied too, as the human's remediation decision
       * (see `rejectionAsRemediation`). Every other rejection stops.
       */
      readonly resolution: 'approved' | 'rejected';
    }
  | {
      readonly kind: 'stop';
      readonly reason: StopReason;
      readonly detail: string;
      readonly taskId: string | null;
      /** An existing approval request this stop is waiting on (pending) or blocked by (rejected). */
      readonly approvalId?: string;
      /** A human approval Forge should request for this stop (none exists for the current evidence yet). */
      readonly approvalRequest?: ApprovalRequestSpec;
    };

/** What the orchestrator records as a pending approval request when it stops. */
export interface ApprovalRequestSpec {
  readonly type: Exclude<ApprovalType, 'lease-recovery'>;
  readonly taskId: string;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly requestedAction: string;
  readonly boundTo: string;
  readonly fingerprint: string;
}

export interface DecisionContext {
  /** The current run's ID; auto-commit only applies to attempts this run produced. */
  readonly runId: string;
  /** Tasks this run has already executed or repaired (counted against `maxTasks`). */
  readonly tasksStarted: ReadonlySet<string>;
  /** Reviews recorded by this run; a failed review is not retried within the same run. */
  readonly reviewsThisRun: ReadonlySet<string>;
  /** AI decisions recorded by this run; a failed decision is not retried within the same run. */
  readonly decisionsThisRun?: ReadonlySet<string>;
}

const COMPLETED_REVIEW = new Set(['clear', 'concerns', 'blocking-concerns']);

export function decideNext(state: ProjectState, view: WorkflowView, policy: OrchestrationPolicy, context: DecisionContext): NextAction {
  if (state.pause !== null) {
    return { kind: 'stop', reason: 'paused', detail: `Paused by a human since ${state.pause.pausedAt}: ${state.pause.reason}`, taskId: null };
  }
  const global = globalStop(state, view);
  if (global !== null) {
    return global;
  }

  for (const task of view.tasks) {
    const followUp = followUpAction(state, task, policy, context);
    if (followUp !== null) {
      return followUp;
    }
  }

  const completable = view.milestones.find((milestone) => milestone.milestone.status === 'active' && milestone.canComplete);
  if (completable !== undefined) {
    return { kind: 'complete-milestone', milestoneId: completable.milestone.id };
  }

  // A failed task whose attempts are used up may still have an unfinished (timed-out or failed)
  // attempt to recover: recovery continues that attempt and has its own budget.
  const next = view.tasks.find((task) => task.runnable || recoveryKindFor(task, policy) !== null);
  if (next !== undefined) {
    return runnableAction(state, next, policy, context);
  }
  return explainIdle(state, view);
}

/** Conditions that must be resolved by a human (or another process) before anything else happens. */
function globalStop(state: ProjectState, view: WorkflowView): NextAction | null {
  const interrupted = view.tasks.find((task) => task.condition === 'interrupted');
  if (interrupted !== undefined) {
    const last = interrupted.lastAttempt!;
    return gate(
      state,
      'interrupted-recovery',
      interrupted,
      stop('interrupted-task', `Task ${interrupted.key} "${interrupted.task.title}" was interrupted and needs recovery`, interrupted),
      [
        `attempt ${last.number} started ${last.startedAt} by pid ${last.executor.pid} on ${last.executor.host}, which is no longer running`,
        `worker run ${last.runId.slice(0, 8)} never recorded an outcome`,
      ],
      'Mark the interrupted attempt as failed (nothing is re-run; a retry needs its own approval). Same as `forge task recover`.',
    );
  }
  const running = view.tasks.find((task) => task.condition === 'running');
  if (running !== undefined) {
    return stop('task-running', `Task ${running.key} "${running.task.title}" is being executed by another Forge process`, running);
  }
  const awaiting = view.tasks.find((task) => task.condition === 'awaiting-validation');
  if (awaiting !== undefined) {
    const note = awaiting.lastAttempt?.note;
    return stop(
      'manual-validation-required',
      `Task ${awaiting.key} "${awaiting.task.title}" is awaiting validation${note === null || note === undefined ? '' : ` (${note})`}`,
      awaiting,
    );
  }
  return null;
}

/**
 * Review and commit for a succeeded task whose latest attempt passed
 * deterministic validation and was produced by an orchestration. A manual
 * attempt (`forge task run`) is left to its human operator, except that an
 * attempt answering OPEN remediation is always reviewed when review is
 * enabled: remediation is only verified by a review decision, never by the
 * worker saying it is done. Only orchestrated work is ever auto-committed.
 */
function followUpAction(state: ProjectState, task: TaskView, policy: OrchestrationPolicy, context: DecisionContext): NextAction | null {
  const attempt = task.lastAttempt;
  if (
    task.task.status !== 'succeeded' ||
    attempt === undefined ||
    attempt.outcome !== 'validated' ||
    task.milestone.status === 'completed' ||
    task.milestone.status === 'cancelled'
  ) {
    return null;
  }
  const remediationOpen = hasOpenRemediation(state, task.task.id);
  if (attempt.origin === null && !(policy.review.enabled && remediationOpen)) {
    return null;
  }

  if (policy.review.enabled) {
    const reviewAction = reviewGate(state, task, attempt.number, policy, context);
    if (reviewAction !== null) {
      return reviewAction;
    }
  }

  if (attempt.origin === null) {
    return null;
  }
  // Work from this run, or orchestrated work from an earlier run that nothing has run after since
  // (e.g. it waited for a human review decision). The M5 safe-commit rules re-verify it live.
  const ownWork = attempt.origin.runId === context.runId || nothingStartedSince(state, attempt.finishedAt);
  if (policy.autoCommit && ownWork && attempt.commit === null && (attempt.changes?.files.length ?? 0) > 0) {
    const eligibility = commitEligibility(attempt);
    if (!eligibility.ok) {
      return stop('commit-refused', `Task ${task.key}: ${eligibility.reason}`, task);
    }
    return { kind: 'commit', taskId: task.task.id, attempt: attempt.number };
  }
  return null;
}

/** True when no task attempt started after `finishedAt` (so no other work can be mixed into its files). */
function nothingStartedSince(state: ProjectState, finishedAt: string | null): boolean {
  return finishedAt !== null && state.tasks.every((task) => task.attempts.every((attempt) => attempt.startedAt <= finishedAt));
}

/** Returns the action the latest review of this attempt requires, or null when the task may progress. */
function reviewGate(state: ProjectState, task: TaskView, attempt: number, policy: OrchestrationPolicy, context: DecisionContext): NextAction | null {
  const review = latestReview(state, task.task.id, attempt);
  if (review === undefined) {
    return { kind: 'review', taskId: task.task.id, attempt, evidenceRound: 0, purpose: 'review' };
  }
  if (!COMPLETED_REVIEW.has(review.status)) {
    // Never treat a missing review as "clear": continue only if policy explicitly allows it.
    if (policy.review.onFailure === 'continue') {
      return null;
    }
    const retry: NextAction = { kind: 'review', taskId: task.task.id, attempt, evidenceRound: review.evidenceRound, purpose: 'retry' };
    if (context.reviewsThisRun.has(review.id)) {
      // Transient reviewer failures are retried within the provider-retry budget (per attempt).
      const failures = state.taskReviews.filter((candidate) => candidate.taskId === task.task.id && candidate.attempt === attempt && !COMPLETED_REVIEW.has(candidate.status)).length;
      const detail = `Review of task ${task.key} did not complete (${review.status}${review.diagnostic === null ? '' : `: ${review.diagnostic}`})`;
      if (failures <= policy.recovery.providerRetries) {
        return { ...retry, backoffMs: backoff(policy, failures) };
      }
      return policy.recovery.providerRetries > 0
        ? stop('provider-retry-exhausted', `${detail}; ${failures} reviewer failure(s) for this attempt, provider-retry budget ${policy.recovery.providerRetries}`, task)
        : stop('reviewer-unavailable', detail, task);
    }
    // A failure from an earlier run: this new run is the retry.
    return retry;
  }
  if (review.decision?.kind === 'accepted') {
    return null;
  }
  // In auto-decision mode, a clear review does not by itself confirm remediation a human or the
  // decision-maker required: the decision-maker must judge it against the evidence.
  const unconfirmed = policy.decision.enabled && review.status === 'clear' && hasOpenRemediation(state, task.task.id, ['human', 'ai']);
  if (review.status === 'clear' && !unconfirmed) {
    return null;
  }
  const count = (severities: readonly string[]): number => review.findings.filter((finding) => severities.includes(finding.severity)).length;
  const evidence = reviewEvidence(task, review);
  const accept =
    'Accept the implementation despite the review (recorded as a human review decision); the run then continues. Rejecting (with a reason saying what to fix) reopens the task for a bounded repair with that reason as its remediation.';
  const acceptanceGate = (stopAction: NextAction, extra: readonly string[] = []): NextAction =>
    rejectionAsRemediation(state, task, policy, gate(state, 'review-acceptance', task, stopAction, [...evidence, ...extra], accept));
  const humanGate = (detail: string, reason: StopReason = 'review-decision-required', extra: readonly string[] = []): NextAction =>
    acceptanceGate(stop(reason, detail, task), extra);
  if (review.status === 'concerns' && policy.review.onConcerns === 'continue') {
    return null;
  }
  const blocking = `Review of task ${task.key} raised ${count(['error', 'critical'])} blocking concern(s)`;
  // Policy-driven repair of blocking concerns (the conservative direction) keeps precedence over auto-decision.
  const policyRepair = review.status === 'blocking-concerns' && policy.repair.onBlockingReview;
  if (policy.decision.enabled && !policyRepair) {
    return decisionGate(state, task, review, policy, context, humanGate);
  }
  if (review.status === 'concerns') {
    return humanGate(`Review of task ${task.key} raised ${count(['warning'])} concern(s); a human decision is required`);
  }
  if (!policy.repair.onBlockingReview) {
    return humanGate(`${blocking}; a human decision is required`);
  }
  const problem = repairProblem(task, policy, 'review') ?? reopenProblem(state, task);
  if (problem !== null) {
    return acceptanceGate(stop(problem.reason, `${blocking}; ${problem.detail}`, task));
  }
  return { kind: 'repair', taskId: task.task.id, trigger: 'review', fromAttempt: attempt, reviewId: review.id, reopen: true };
}

function runnableAction(state: ProjectState, task: TaskView, policy: OrchestrationPolicy, context: DecisionContext): NextAction {
  const overLimit =
    !context.tasksStarted.has(task.task.id) && context.tasksStarted.size >= policy.maxTasks
      ? stop('limit-tasks', `This run already processed ${context.tasksStarted.size} task(s) (limit ${policy.maxTasks}); next is ${task.key}`, task)
      : null;

  if (task.task.status === 'pending') {
    return overLimit ?? { kind: 'execute', taskId: task.task.id };
  }

  // A failed task with attempts remaining: only a policy-permitted repair may re-run it.
  const last = task.lastAttempt!;
  const evidence = attemptEvidence(task, policy);
  const retry = 'Run ONE more attempt of the task (with the failure evidence when it failed validation or review); it is validated normally.';
  if (task.requiresIntegrityAcknowledgement) {
    return gate(
      state,
      'violation-acknowledgement',
      task,
      stop(
        last.outcome === 'scope-violation' ? 'scope-acknowledgement-required' : 'integrity-acknowledgement-required',
        `Task ${task.key}'s last attempt ended in a ${last.outcome}${last.note === null ? '' : ` (${last.note})`}`,
        task,
      ),
      evidence,
      'Retry the task once, acknowledging the violation (inspect .forge/ and the changes first); the attempt is validated normally.',
      overLimit,
    );
  }
  if (last.outcome === 'validation-failed') {
    if (!policy.repair.onValidationFailure) {
      return gate(state, 'task-retry', task, stop('repair-not-permitted', `Task ${task.key} failed deterministic validation${last.note === null ? '' : ` (${last.note})`}`, task), evidence, retry, overLimit);
    }
    const problem = repairProblem(task, policy, 'validation');
    if (problem !== null) {
      return gate(state, 'task-retry', task, stop(problem.reason, `Task ${task.key} failed deterministic validation; ${problem.detail}`, task), evidence, retry, overLimit);
    }
    return overLimit ?? { kind: 'repair', taskId: task.task.id, trigger: 'validation', fromAttempt: last.number, reviewId: null, reopen: false };
  }
  if (last.outcome === 'review-rejected') {
    const review = state.taskReviews.find(
      (candidate) => candidate.taskId === task.task.id && candidate.attempt === last.number && candidate.decision?.kind === 'remediation-required',
    );
    // Remediation decided by the AI decision-maker is repaired automatically in an auto-decision run (budget permitting),
    // and so is remediation a human asked for by rejecting Forge's review-acceptance request: that rejection IS the
    // instruction to repair.
    const decision = review?.decision ?? null;
    const permitted =
      policy.repair.onBlockingReview || (policy.decision.enabled && decision?.by === 'ai') || (decision?.by === 'human' && decision.approvalId !== null);
    if (!permitted || review === undefined) {
      return gate(state, 'task-retry', task, stop('review-remediation-required', `Task ${task.key} was reopened for remediation after a review`, task), evidence, retry, overLimit);
    }
    const problem = repairProblem(task, policy, 'review');
    if (problem !== null) {
      return gate(state, 'task-retry', task, stop(problem.reason, `Task ${task.key} requires remediation; ${problem.detail}`, task), evidence, retry, overLimit);
    }
    return overLimit ?? { kind: 'repair', taskId: task.task.id, trigger: 'review', fromAttempt: last.number, reviewId: review.id, reopen: false };
  }
  // A timed-out or failed worker invocation is recovered within its budget, when its partial work is safe.
  const kind = recoveryKindFor(task, policy);
  if (kind !== null) {
    return recoveryAction(state, task, policy, kind, evidence, overLimit);
  }
  // Cancellations, human rejections, and failures without a recovery budget: a human decides.
  return gate(state, 'task-retry', task, stop('worker-failed', `Task ${task.key}'s last attempt ended as ${last.outcome}${last.note === null ? '' : ` (${last.note})`}`, task), evidence, retry, overLimit);
}

/**
 * The recovery that applies to a failed task's unfinished last attempt, or
 * null: `timeout` after a worker timeout, `worker-failure` after a failed
 * invocation (process failure, unavailable, unusable output) — and only
 * when the policy gives that kind a budget. Cancellation, integrity and scope
 * violations, validation failures and review rejections are never recovered
 * this way.
 */
function recoveryKindFor(task: TaskView, policy: OrchestrationPolicy): 'timeout' | 'worker-failure' | null {
  const last = task.lastAttempt;
  if (task.task.status !== 'failed' || last === undefined || task.requiresIntegrityAcknowledgement) {
    return null;
  }
  if (RECOVERABLE_OUTCOMES.timeout.includes(last.outcome)) {
    return policy.recovery.timeoutRecoveries > 0 ? 'timeout' : null;
  }
  if (RECOVERABLE_OUTCOMES['worker-failure'].includes(last.outcome)) {
    return policy.recovery.providerRetries > 0 ? 'worker-failure' : null;
  }
  return null;
}

/**
 * Continues an unfinished attempt — never blindly. The partial work the
 * interrupted worker left is judged by the same attribution rules as a safe
 * commit (no out-of-scope path, moved HEAD, mixed or staged files, and it
 * must have been measured); protected Forge state was already guarded (that
 * attempt would be an integrity violation, never recovered). Safe work is
 * kept and continued; anything else stops for a human. Each kind is bounded
 * by its own budget, counted from the stored attempts.
 */
function recoveryAction(
  state: ProjectState,
  task: TaskView,
  policy: OrchestrationPolicy,
  kind: 'timeout' | 'worker-failure',
  evidence: readonly string[],
  overLimit: NextAction | null,
): NextAction {
  const last = task.lastAttempt!;
  const retry = 'Run ONE more attempt of the task (with the failure evidence when it failed validation or review); it is validated normally.';
  const what = kind === 'timeout' ? 'timed out' : `failed (${last.outcome})`;
  // A read-only worker cannot change files, so there is nothing to attribute.
  const problem = last.changes === null && policy.access === 'read-only' ? null : partialWorkProblem(last.changes);
  if (problem !== null) {
    return gate(
      state,
      'task-retry',
      task,
      stop('unsafe-partial-work', `Task ${task.key}'s worker ${what} and left work Forge will not continue automatically: ${problem}`, task),
      evidence,
      retry,
      overLimit,
    );
  }
  const used = attemptsWithTrigger(task.task, kind);
  const budget = kind === 'timeout' ? policy.recovery.timeoutRecoveries : policy.recovery.providerRetries;
  const hardLimit = kind === 'timeout' ? ORCHESTRATION_LIMITS.maxTimeoutRecoveries : ORCHESTRATION_LIMITS.maxProviderRetries;
  if (used >= Math.min(budget, hardLimit)) {
    return gate(
      state,
      'task-retry',
      task,
      stop(
        kind === 'timeout' ? 'timeout-recovery-exhausted' : 'provider-retry-exhausted',
        `Task ${task.key}'s worker ${what} again; ${used}/${budget} ${kind === 'timeout' ? 'timeout recoveries' : 'provider retries'} used`,
        task,
      ),
      evidence,
      retry,
      overLimit,
    );
  }
  return (
    overLimit ?? {
      kind: 'repair',
      taskId: task.task.id,
      trigger: kind,
      fromAttempt: last.number,
      reviewId: null,
      reopen: false,
      ...(kind === 'worker-failure' ? { backoffMs: backoff(policy, used + 1) } : {}),
    }
  );
}

/** Wait before the Nth provider retry (linear backoff, bounded by policy). */
function backoff(policy: OrchestrationPolicy, retry: number): number {
  return Math.min(ORCHESTRATION_LIMITS.maxRetryBackoffMs, policy.recovery.retryBackoffMs * retry);
}

/**
 * Turns a human-required stop into an approval decision point. An approval
 * applies only while its fingerprint matches the current evidence:
 *   approved  -> apply it (one use; the orchestrator consumes it)
 *   rejected  -> stop: a human said no
 *   pending   -> stop and point at it
 *   none      -> stop and ask the orchestrator to request one
 */
function gate(
  state: ProjectState,
  type: Exclude<ApprovalType, 'lease-recovery'>,
  task: TaskView,
  stopAction: NextAction,
  evidence: readonly string[],
  requestedAction: string,
  overLimit: NextAction | null = null,
): NextAction {
  if (stopAction.kind !== 'stop') {
    return stopAction;
  }
  const binding = taskApprovalBinding(state, type, task.task.id)!;
  const match = [...state.approvals]
    .reverse()
    .find(
      (approval) =>
        approval.type === type &&
        approval.taskId === task.task.id &&
        approval.fingerprint === binding.fingerprint &&
        (approval.status === 'pending' || approval.status === 'approved' || approval.status === 'rejected'),
    );
  if (match?.status === 'approved') {
    return overLimit ?? { kind: 'apply-approval', approvalId: match.id, approvalType: type, taskId: task.task.id, resolution: 'approved' };
  }
  if (match?.status === 'rejected') {
    return {
      kind: 'stop',
      reason: 'approval-rejected',
      detail: `${stopAction.detail}; approval ${match.id.slice(0, 8)} was rejected by a human: ${match.resolution?.reason ?? ''}`,
      taskId: task.task.id,
      approvalId: match.id,
    };
  }
  if (match?.status === 'pending') {
    return { ...stopAction, detail: `${stopAction.detail}; approval ${match.id.slice(0, 8)} is pending`, approvalId: match.id };
  }
  return {
    ...stopAction,
    approvalRequest: { type, taskId: task.task.id, reason: stopAction.detail, evidence, requestedAction, boundTo: binding.boundTo, fingerprint: binding.fingerprint },
  };
}

/** Bounded evidence for a review-acceptance request: Forge-derived status, finding titles, and validation result. */
function reviewEvidence(task: TaskView, review: TaskReview): string[] {
  const validation = task.lastAttempt?.validation ?? null;
  return [
    `deterministic validation: ${validation === null ? 'none' : `${validation.status} (${validation.checks.filter((check) => check.status === 'passed').map((check) => check.id).join(', ')})`}`,
    `review ${review.id.slice(0, 8)}: ${review.status} (reviewer ${review.call.provider}; advisory)`,
    ...review.findings.slice(0, 8).map((finding) => `[${finding.severity}] ${finding.title}`),
    ...(review.findings.length > 8 ? [`… and ${review.findings.length - 8} more finding(s); see forge task review-show ${task.key}`] : []),
  ];
}

/** Bounded evidence for a retry / acknowledgement request. */
function attemptEvidence(task: TaskView, policy: OrchestrationPolicy): string[] {
  const last = task.lastAttempt!;
  return [
    `attempt ${last.number} (implementation attempts ${task.attemptsUsed}/${task.task.maxAttempts}): ${last.outcome}${last.note === null ? '' : ` — ${last.note}`}`,
    `deterministic validation: ${last.validation?.status ?? 'not run'}`,
    `repairs used: ${repairsUsed(task.task)} (policy allows ${policy.repair.onValidationFailure || policy.repair.onBlockingReview ? policy.repair.maxPerTask : 0})`,
    `timeout recoveries used: ${attemptsWithTrigger(task.task, 'timeout')}/${policy.recovery.timeoutRecoveries}; provider retries used: ${attemptsWithTrigger(task.task, 'worker-failure')}/${policy.recovery.providerRetries}`,
    `changed files: ${last.changes?.files.length ?? 0}`,
  ];
}

/**
 * Why the task cannot get another implementation repair of this kind (the
 * shared repair budget, or its implementation attempts), or null. The stop
 * reason names the kind of repair that was needed.
 */
function repairProblem(task: TaskView, policy: OrchestrationPolicy, trigger: 'validation' | 'review'): { reason: StopReason; detail: string } | null {
  const reason: StopReason = trigger === 'validation' ? 'validation-repair-exhausted' : 'review-repair-exhausted';
  const used = repairsUsed(task.task);
  if (used >= policy.repair.maxPerTask) {
    return { reason, detail: `the repair budget is used up (${used}/${policy.repair.maxPerTask}: ${describeRepairs(task)})` };
  }
  if (task.attemptsUsed >= task.task.maxAttempts) {
    return { reason, detail: `all ${task.task.maxAttempts} attempts have been used` };
  }
  return null;
}

function describeRepairs(task: TaskView): string {
  return `${attemptsWithTrigger(task.task, 'validation')} validation, ${attemptsWithTrigger(task.task, 'review')} review`;
}

/** A succeeded task can only be reopened while nothing was built on it (same rule as a human remediation). */
function reopenProblem(state: ProjectState, task: TaskView): { reason: StopReason; detail: string } | null {
  const dependents = state.tasks.filter((candidate) => candidate.dependsOn.includes(task.task.id) && candidate.attempts.length > 0);
  if (dependents.length > 0) {
    return { reason: 'review-decision-required', detail: 'dependent tasks already ran on top of it, so Forge will not reopen it' };
  }
  return null;
}

/** Nothing is runnable: say precisely why, distinguishing completion from every kind of blockage. */
function explainIdle(state: ProjectState, view: WorkflowView): NextAction {
  if (state.milestones.length === 0 && state.tasks.length === 0) {
    return { kind: 'stop', reason: 'no-work', detail: 'There are no milestones or tasks', taskId: null };
  }
  const terminal = (status: string): boolean => status === 'completed' || status === 'cancelled';
  if (
    view.milestones.every((milestone) => terminal(milestone.milestone.status)) &&
    view.tasks.every((task) => task.task.status === 'succeeded' || task.task.status === 'cancelled')
  ) {
    const completed = view.milestones.filter((milestone) => milestone.milestone.status === 'completed').length;
    return { kind: 'stop', reason: 'complete', detail: `All ${view.milestones.length} milestone(s) are finished (${completed} completed)`, taskId: null };
  }
  const exhausted = view.tasks.find((task) => task.condition === 'exhausted');
  if (exhausted !== undefined) {
    return stop('retry-exhausted', `Task ${exhausted.key} "${exhausted.task.title}" used all ${exhausted.task.maxAttempts} attempts`, exhausted);
  }
  const blocked = view.tasks.find((task) => task.condition === 'blocked');
  if (blocked !== undefined) {
    return stop('blocked', `Task ${blocked.key} "${blocked.task.title}" is blocked: a dependency can never succeed`, blocked);
  }
  const stuck = view.milestones.find(
    (milestone) =>
      !terminal(milestone.milestone.status) && milestone.tasks.every((task) => task.task.status === 'succeeded' || task.task.status === 'cancelled'),
  );
  if (stuck !== undefined) {
    return {
      kind: 'stop',
      reason: 'milestone-incomplete',
      detail: `Milestone ${stuck.milestone.order} "${stuck.milestone.title}" ${stuck.tasks.length === 0 ? 'has no tasks' : 'has no succeeded task'}`,
      taskId: null,
    };
  }
  return { kind: 'stop', reason: 'no-runnable-task', detail: 'No task is runnable', taskId: null };
}

/**
 * Auto-decision for a review that would otherwise stop for a human:
 *   no decision yet                  -> ask the decision-maker
 *   accepted below high confidence while the evidence was observably
 *   truncated                        -> re-review with expanded evidence and
 *                                       decide again (bounded per attempt)
 *   decided, but escalated           -> stop for a human (its reason is evidence)
 *   no usable answer, earlier run    -> ask again (bounded per review), unless a
 *                                       human already approved or rejected the
 *                                       acceptance for this exact evidence
 *   no usable answer, this run       -> ask again only within the provider-retry budget
 *   otherwise                        -> stop for a human; never treated as acceptance
 * Accepted and remediation-required effects never reach here: they decided the review.
 */
function decisionGate(
  state: ProjectState,
  task: TaskView,
  review: TaskReview,
  policy: OrchestrationPolicy,
  context: DecisionContext,
  humanGate: (detail: string, reason: StopReason, extra: readonly string[]) => NextAction,
): NextAction {
  const tries = state.aiDecisions.filter((decision) => decision.reviewId === review.id);
  const last = tries.at(-1);
  const ask: NextAction = { kind: 'decide', taskId: task.task.id, attempt: review.attempt, reviewId: review.id, retry: false };
  if (last === undefined) {
    return ask;
  }
  if (last.status === 'decided' && evidenceLimited(review, last)) {
    // The decision-maker would accept but was not confident, and Forge's own records show the evidence
    // it saw was cut short (truncated or omitted files): first show it more, then decide again.
    const round = review.evidenceRound + 1;
    if (round <= Math.min(policy.recovery.evidenceReviews, ORCHESTRATION_LIMITS.maxEvidenceReviews)) {
      return { kind: 'review', taskId: task.task.id, attempt: review.attempt, evidenceRound: round, purpose: 'expand' };
    }
    if (policy.recovery.evidenceReviews > 0) {
      return humanGate(
        `The AI decision-maker would accept task ${task.key} but only with ${last.confidence} confidence, and the evidence is still truncated after ${review.evidenceRound} expanded re-review(s)`,
        'evidence-review-exhausted',
        decisionEvidence(last),
      );
    }
  }
  if (last.status === 'decided') {
    const why = last.humanReason ?? last.policyNote ?? last.reason ?? 'no reason given';
    // The model asked for a human, or Forge's rules refused to let its verdict take effect.
    const verdict = `${last.verdict}, confidence ${last.confidence}`;
    return last.verdict === 'escalate'
      ? humanGate(`The AI decision-maker escalated review of task ${task.key} (${verdict}): ${why}`, 'decision-escalated', decisionEvidence(last))
      : humanGate(`Forge did not apply the AI decision-maker's verdict on review of task ${task.key} (${verdict}): ${why}`, 'decision-overruled', decisionEvidence(last));
  }
  const thisRun = context.decisionsThisRun?.has(last.id) ?? false;
  // Within this run, an unusable answer is retried only within the provider-retry budget.
  const retryAllowed = tries.length < AI_LIMITS.aiDecisionsPerReview && (!thisRun || tries.length <= policy.recovery.providerRetries);
  const human = humanGate(
    `The AI decision-maker gave no usable answer for task ${task.key} (${last.status}${last.diagnostic === null ? '' : `: ${last.diagnostic}`}); a human decision is required`,
    !retryAllowed && policy.recovery.providerRetries > 0 ? 'provider-retry-exhausted' : unusableAnswerReason(last),
    decisionEvidence(last),
  );
  if (!retryAllowed) {
    return human;
  }
  // A human's answer to the request for this same evidence outranks asking the AI again: an
  // approval is used as approved, and a rejection is never overridden by a later AI acceptance.
  // A still-pending request does not block the retry; a usable answer changes the evidence the
  // request is bound to (see `taskApprovalBinding`), so the request can no longer be used.
  if (human.kind === 'apply-approval' || (human.kind === 'stop' && (human.reason === 'approval-rejected' || human.reason === 'review-rejection-blocked'))) {
    return human;
  }
  return { ...ask, retry: true, ...(thisRun ? { backoffMs: backoff(policy, tries.length) } : {}) };
}

/**
 * Whether a usable decision was limited by evidence rather than by the work:
 * the decision-maker answered "accept" but below high confidence, AND Forge's
 * own records (not the model) show the review or decision packet was
 * truncated — files omitted or cut short by the evidence limits.
 */
function evidenceLimited(review: TaskReview, decision: AiDecisionRecord): boolean {
  return decision.verdict === 'accept' && decision.confidence !== 'high' && (review.context.truncated || decision.context.truncated);
}

/** The stop reason for a decision attempt that produced no usable answer, by what actually happened. */
function unusableAnswerReason(decision: AiDecisionRecord): StopReason {
  switch (decision.status) {
    case 'invalid-output':
      return 'decision-maker-invalid-output';
    case 'timeout':
      return 'decision-maker-timeout';
    default:
      // unavailable, failed, or cancelled in an earlier run: the provider produced no answer at all.
      return 'decision-maker-unavailable';
  }
}

/**
 * A human REJECTED Forge's request to accept this implementation. Approval
 * semantics are type-specific: for `review-acceptance` (and only it) a
 * rejection means "not accepted; revise it", so it is applied as the human's
 * `remediation-required` review decision with the rejection reason as the
 * requirement, through the same transition as `forge task review-reject`.
 * Reopening is only proposed when a bounded repair can follow and the task
 * may still be reopened; otherwise the run stops and names the blocker.
 * Every other rejected approval (retry, violation acknowledgement, recovery)
 * stays a stop.
 *
 * Exactly once: applying it decides the review the approval was bound to, so
 * its fingerprint no longer matches and it is never matched again.
 */
function rejectionAsRemediation(state: ProjectState, task: TaskView, policy: OrchestrationPolicy, action: NextAction): NextAction {
  if (action.kind !== 'stop' || action.reason !== 'approval-rejected' || action.approvalId === undefined) {
    return action;
  }
  const approval = state.approvals.find((candidate) => candidate.id === action.approvalId);
  if (approval === undefined || approval.type !== 'review-acceptance' || approval.status !== 'rejected') {
    return action;
  }
  const blocker = repairProblem(task, policy, 'review') ?? reopenProblem(state, task);
  if (blocker !== null) {
    return {
      kind: 'stop',
      reason: 'review-rejection-blocked',
      detail: `A human rejected review acceptance of task ${task.key} (approval ${approval.id.slice(0, 8)}: ${approval.resolution?.reason ?? ''}), but Forge cannot reopen it for remediation: ${blocker.detail}`,
      taskId: task.task.id,
      approvalId: approval.id,
    };
  }
  return { kind: 'apply-approval', approvalId: approval.id, approvalType: 'review-acceptance', taskId: task.task.id, resolution: 'rejected' };
}

/** Bounded evidence lines from an AI decision, for the human approval request. */
function decisionEvidence(decision: AiDecisionRecord): string[] {
  return [
    `AI decision ${decision.id.slice(0, 8)} by ${decision.call.provider}: ${decision.status === 'decided' ? `${decision.verdict} (confidence ${decision.confidence}) -> ${decision.effect}` : decision.status}`,
    ...(decision.policyNote === null ? [] : [`Forge rule: ${decision.policyNote}`]),
    ...(decision.humanReason === null ? [] : [`needs a human because: ${decision.humanReason}`]),
  ];
}

/** Whether the task has open remediation (optionally only from the given deciders). */
function hasOpenRemediation(state: ProjectState, taskId: string, sources?: readonly string[]): boolean {
  return state.remediations.some((remediation) => remediation.taskId === taskId && remediation.status === 'open' && (sources === undefined || sources.includes(remediation.source)));
}

export function latestReview(state: ProjectState, taskId: string, attempt: number): TaskReview | undefined {
  return [...state.taskReviews].reverse().find((review) => review.taskId === taskId && review.attempt === attempt);
}

function stop(reason: StopReason, detail: string, task: TaskView): NextAction {
  return { kind: 'stop', reason, detail, taskId: task.task.id };
}
