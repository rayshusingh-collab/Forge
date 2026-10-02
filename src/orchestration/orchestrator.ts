import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { AiProvider } from '../ai/index.ts';
import { ForgeError, IntegrityError, WorkflowError } from '../core/errors.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { consumeApproval, currentFingerprint, requestApproval, staleApprovals, sweepApprovals } from '../approvals/index.ts';
import { decideTask } from '../decision/index.ts';
import { decideReview, reviewTask } from '../review/index.ts';
import type {
  AttemptOrigin,
  OrchestrationAction,
  OrchestrationCounters,
  OrchestrationPolicy,
  OrchestrationStop,
  ProjectState,
  RepairTrigger,
  ReviewStatus,
  StateStore,
  ValidationStatus,
} from '../state/index.ts';
import { AI_LIMITS, ORCHESTRATION_LIMITS, RECOVERABLE_OUTCOMES, attemptsWithTrigger, implementationAttempts, isRecoveryTrigger, nextRepairNumber } from '../state/index.ts';
import { TaskEngine, deriveWorkflow, processLiveness, recoverTask, repairsUsed } from '../tasks/index.ts';
import type { ExecutorLiveness, WorkflowView } from '../tasks/index.ts';
import type { Worker } from '../workers/index.ts';
import { decideNext } from './decision.ts';
import type { DecisionContext, NextAction } from './decision.ts';
import { EMPTY_COUNTERS, beginRun, finishRun, recordEvent } from './history.ts';
import { acquireOrchestrationLease } from './lease.ts';
import type { OrchestrationLease } from './lease.ts';
import { policyHash, workerTimeoutFor } from './policy.ts';
import { buildRepairEvidence } from './repair.ts';

/**
 * The orchestration loop. Forge — not an AI provider — owns it:
 *
 *   acquire lease -> record run -> repeat {
 *     check cancellation, lease, and step budget
 *     load state -> decideNext (pure) -> perform ONE action -> record event
 *   } until a stop reason -> record stop -> release lease
 *
 * Every action reuses an existing service (task engine, validator via the
 * engine, reviewer, safe commit, milestone transition); the orchestrator
 * adds sequencing, budgets, and the stop decision, never new ways to change
 * the project. Worker, reviewer, and validation output only ever reach it
 * as Forge's own structured records.
 */

export interface OrchestratorOptions {
  readonly project: LoadedProject;
  readonly store: StateStore;
  readonly engine: TaskEngine;
  readonly runner: ProcessExecutor;
  /** The implementer for every task attempt this run makes. */
  readonly worker: Worker;
  /** The reviewer; required when the policy enables review. */
  readonly reviewer: AiProvider | null;
  /** The AI decision-maker; required when the policy enables auto-decision. */
  readonly decisionMaker?: AiProvider | null;
  readonly policy: OrchestrationPolicy;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly liveness?: ExecutorLiveness;
  /** Aborting cancels the active operation and stops the loop; nothing else starts. */
  readonly signal?: AbortSignal;
  readonly reporter?: OrchestrationReporter;
}

/** Receives progress as it happens (for terminal output). */
export interface OrchestrationReporter {
  /** Awaited before the next decision, so a reporter never races the loop. */
  onStep?(step: StepResult): void | Promise<void>;
}

export interface StepResult {
  /** 1-based step number within the run. */
  readonly step: number;
  readonly action: OrchestrationAction;
  readonly taskId: string | null;
  /** Display key such as `1.2`. */
  readonly taskKey: string | null;
  readonly taskTitle: string | null;
  readonly milestoneId: string | null;
  readonly attempt: number | null;
  /** Machine-readable outcome code, e.g. `validated`, `validation-failed`, `concerns`, `committed`. */
  readonly outcome: string;
  readonly detail: string | null;
  readonly worker: { readonly id: string; readonly outcome: string } | null;
  readonly validation: ValidationStatus | null;
  readonly review: ReviewStatus | null;
  /** Implementation repair or recovery continuation; `max` is that kind's budget. */
  readonly repair: { readonly number: number; readonly max: number; readonly trigger: RepairTrigger } | null;
  /** Worker timeout used for this attempt (adaptive for timeout recoveries). */
  readonly timeoutMs?: number;
  /** For a timed-out or failed worker: what Forge measured of its partial work. */
  readonly partialWork?: { readonly files: number } | null;
  readonly commit: string | null;
  /** Set when this step itself ended the run (e.g. an integrity violation). */
  readonly stop: OrchestrationStop | null;
}

export interface RunResult {
  readonly runId: string;
  readonly steps: readonly StepResult[];
  readonly counters: OrchestrationCounters;
  readonly stop: OrchestrationStop;
  /** Key of the first runnable task after the run, if any. */
  readonly nextRunnable: string | null;
  /** Display key of the task the stop reason is about, if any. */
  readonly stopTaskKey: string | null;
  /** False when the final state could not be recorded (reported, never hidden). */
  readonly recorded: boolean;
  /** The approval request this stop waits on (created now or earlier), if any. */
  readonly approvalId: string | null;
  /** True when this run created that approval request. */
  readonly approvalCreated: boolean;
}

export class Orchestrator {
  private readonly options: OrchestratorOptions;
  private readonly clock: () => Date;
  private readonly liveness: ExecutorLiveness;
  private readonly runId: string;
  private counters: OrchestrationCounters = EMPTY_COUNTERS;
  private readonly tasksStarted = new Set<string>();
  private readonly reviewsThisRun = new Set<string>();
  private readonly decisionsThisRun = new Set<string>();
  private stopApproval: { readonly id: string; readonly created: boolean } | null = null;

  constructor(options: OrchestratorOptions) {
    if (options.policy.review.enabled && options.reviewer === null) {
      throw new WorkflowError('The policy enables AI review but no reviewer was provided');
    }
    if (options.policy.decision.enabled && (options.decisionMaker ?? null) === null) {
      throw new WorkflowError('The policy enables auto-decision but no decision-maker was provided');
    }
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.liveness = options.liveness ?? processLiveness;
    this.runId = (options.generateId ?? randomUUID)();
  }

  get id(): string {
    return this.runId;
  }

  /**
   * `mode: 'run'` loops until a stop reason; `mode: 'step'` performs at
   * most one workflow step. Throws only when the run could not start
   * (e.g. another run holds the lease); once started, every outcome —
   * including unexpected errors — is returned as a recorded stop reason.
   */
  async run(mode: 'run' | 'step' = 'run'): Promise<RunResult> {
    const { project, store, policy } = this.options;
    const lease = await acquireOrchestrationLease(project.layout, this.runId, this.clock());
    try {
      await store.update((state) =>
        beginRun(
          state,
          { id: this.runId, mode, owner: { pid: process.pid, host: hostname() }, policy, policyHash: policyHash(policy), liveness: this.liveness },
          this.clock(),
        ),
      );
    } catch (error) {
      await lease.release();
      throw error;
    }

    const steps: StepResult[] = [];
    let stop: OrchestrationStop;
    let leaseIntact = true;
    try {
      stop = await this.loop(mode, lease, steps);
      leaseIntact = stop.reason !== 'lease-lost';
    } catch (error) {
      stop = { reason: 'error', detail: describe(error), taskId: null };
    }

    let recorded = true;
    try {
      await store.update((state) => finishRun(state, this.runId, stop, this.counters, this.clock()));
    } catch {
      recorded = false;
    }
    if (leaseIntact) {
      // Removes the lock only if it is still provably ours.
      await lease.release();
    }
    const view = await this.view().catch(() => undefined);
    const stopTaskKey = stop.taskId === null ? null : (view?.task(stop.taskId)?.key ?? null);
    return {
      runId: this.runId,
      steps,
      counters: this.counters,
      stop,
      nextRunnable: view?.runnable[0]?.key ?? null,
      stopTaskKey,
      recorded,
      approvalId: this.stopApproval?.id ?? null,
      approvalCreated: this.stopApproval?.created ?? false,
    };
  }

  private async loop(mode: 'run' | 'step', lease: OrchestrationLease, steps: StepResult[]): Promise<OrchestrationStop> {
    const { policy, signal } = this.options;
    for (;;) {
      if (signal?.aborted === true) {
        return { reason: 'cancelled', detail: 'Interrupted by the user; nothing further was started', taskId: null };
      }
      if (!(await lease.isIntact())) {
        return { reason: 'lease-lost', detail: `${lease.path} was removed or replaced during the run`, taskId: null };
      }
      if (mode === 'step' && steps.length >= 1) {
        return { reason: 'step-done', detail: 'One step was performed', taskId: null };
      }
      if (this.counters.steps >= policy.maxSteps) {
        return { reason: 'limit-steps', detail: `This run performed ${this.counters.steps} step(s) (limit ${policy.maxSteps})`, taskId: null };
      }

      let state = await this.options.store.load();
      if (staleApprovals(state).length > 0) {
        // Approvals bound to evidence that has since changed can never be used.
        state = await this.options.store.update((current) => sweepApprovals(current, this.clock()));
      }
      const view = deriveWorkflow(state, this.liveness);
      const action = decideNext(state, view, policy, this.context());
      if (action.kind === 'stop') {
        return this.stopWith(action);
      }

      const step = await this.perform(action, state, view);
      steps.push(step);
      try {
        await this.options.store.update((current) =>
          recordEvent(
            current,
            this.runId,
            { step: step.step, action: step.action, taskId: step.taskId, milestoneId: step.milestoneId, attempt: step.attempt, outcome: step.outcome, detail: step.detail },
            this.counters,
            this.clock(),
          ),
        );
      } catch (error) {
        // Continuing without a trustworthy record is never safe; keep the step's own reason if it had one.
        await this.options.reporter?.onStep?.(step);
        return step.stop ?? { reason: 'state-not-recorded', detail: `The orchestration event could not be recorded: ${describe(error)}`, taskId: step.taskId };
      }
      await this.options.reporter?.onStep?.(step);
      if (step.stop !== null) {
        return step.stop;
      }
    }
  }

  /**
   * Ends the loop. A human-required stop records (or points at) the
   * approval request a human can resolve with `forge approval`; Forge
   * never resolves it itself.
   */
  private async stopWith(action: Extract<NextAction, { kind: 'stop' }>): Promise<OrchestrationStop> {
    const request = action.approvalRequest;
    if (request !== undefined) {
      let created = false;
      let id = '';
      await this.options.store.update((current) => {
        const result = requestApproval(
          current,
          { ...request, id: (this.options.generateId ?? randomUUID)(), runId: this.runId },
          this.clock(),
        );
        created = result.created;
        id = result.approval.id;
        return result.state;
      });
      this.stopApproval = { id, created };
      return { reason: action.reason, detail: `${action.detail}; approval ${id.slice(0, 8)} ${created ? 'requested' : 'pending'}`, taskId: action.taskId };
    }
    if (action.approvalId !== undefined) {
      this.stopApproval = { id: action.approvalId, created: false };
    }
    return { reason: action.reason, detail: action.detail, taskId: action.taskId };
  }

  private context(): DecisionContext {
    return { runId: this.runId, tasksStarted: this.tasksStarted, reviewsThisRun: this.reviewsThisRun, decisionsThisRun: this.decisionsThisRun };
  }

  /** Performs exactly one action. Expected refusals become a stop on the step; nothing is retried here. */
  private async perform(action: Exclude<NextAction, { kind: 'stop' }>, state: ProjectState, view: WorkflowView): Promise<StepResult> {
    this.counters = { ...this.counters, steps: this.counters.steps + 1 };
    if ('backoffMs' in action && action.backoffMs !== undefined && action.backoffMs > 0) {
      // A provider retry waits first (bounded by policy; Ctrl+C ends the wait).
      await this.wait(action.backoffMs);
    }
    const taskId = 'taskId' in action ? action.taskId : null;
    const task = taskId === null ? undefined : view.task(taskId);
    const base: StepResult = {
      step: this.counters.steps,
      action: action.kind,
      taskId,
      taskKey: task?.key ?? null,
      taskTitle: task?.task.title ?? null,
      milestoneId: action.kind === 'complete-milestone' ? action.milestoneId : (task?.milestone.id ?? null),
      attempt: null,
      outcome: 'started',
      detail: null,
      worker: null,
      validation: null,
      review: null,
      repair: null,
      commit: null,
      stop: null,
    };
    try {
      switch (action.kind) {
        case 'execute':
        case 'repair':
          return await this.executeTask(action, state, base);
        case 'review':
          return await this.review(action, base);
        case 'decide':
          return await this.decide(action, base);
        case 'commit':
          return await this.commit(action.taskId, base);
        case 'apply-approval':
          return await this.applyApproval(action, base);
        case 'complete-milestone':
          await this.options.engine.completeMilestone(action.milestoneId);
          this.counters = { ...this.counters, milestones: this.counters.milestones + 1 };
          return { ...base, outcome: 'completed', detail: `Milestone "${view.milestone(action.milestoneId)?.milestone.title ?? action.milestoneId}" completed` };
      }
    } catch (error) {
      return this.failedStep(base, error);
    }
  }

  /**
   * Uses ONE approved approval. Consumption is recorded first, atomically
   * and only if the evidence still matches its fingerprint (otherwise the
   * approval is invalidated and the next decision asks again). Then the
   * single action it authorizes happens through the normal services.
   */
  private async applyApproval(action: Extract<NextAction, { kind: 'apply-approval' }>, base: StepResult): Promise<StepResult> {
    this.counters = { ...this.counters, humanInterventions: this.counters.humanInterventions + 1 };
    if (action.resolution === 'rejected') {
      return this.applyReviewRejection(action, base);
    }
    const { store } = this.options;
    const now = this.clock();
    let stale = false;
    let reason = '';
    const after = await store.update((current) => {
      const approval = current.approvals.find((candidate) => candidate.id === action.approvalId)!;
      reason = approval.resolution?.reason ?? '';
      const result = consumeApproval(current, approval.id, this.runId, currentFingerprint(current, approval), now);
      stale = result.kind === 'stale';
      if (stale) {
        return result.state;
      }
      switch (action.approvalType) {
        case 'review-acceptance':
          return decideReview(result.state, action.taskId, 'accepted', boundedReason(`Accepted by a human through approval ${approval.id.slice(0, 8)}: ${reason}`), now, 'human', {
            approvalId: approval.id,
          });
        case 'interrupted-recovery':
          // Marks the interrupted attempt failed; never re-runs it.
          return recoverTask(result.state, action.taskId, { force: false, liveness: this.liveness }, now);
        default:
          return result.state;
      }
    });
    const id = action.approvalId.slice(0, 8);
    if (stale) {
      return { ...base, outcome: 'approval-invalidated', detail: `Approval ${id} no longer matched the evidence and was invalidated; nothing was done` };
    }
    switch (action.approvalType) {
      case 'review-acceptance':
        return { ...base, outcome: 'review-accepted', detail: `Approval ${id} used: review accepted by a human (${reason})` };
      case 'interrupted-recovery':
        return { ...base, outcome: 'recovered', detail: `Approval ${id} used: the interrupted attempt was marked failed; nothing was re-run` };
      case 'violation-acknowledgement': {
        const step = await this.executeTask({ kind: 'execute', taskId: action.taskId }, after, base, true);
        return { ...step, detail: `Approval ${id} used (violation acknowledged)${step.detail === null ? '' : `; ${step.detail}`}` };
      }
      default: {
        const task = after.tasks.find((candidate) => candidate.id === action.taskId)!;
        const last = task.attempts.at(-1)!;
        const remediation = after.taskReviews.find(
          (review) => review.taskId === task.id && review.attempt === last.number && review.decision?.kind === 'remediation-required',
        );
        const canRepair = repairsUsed(task) < ORCHESTRATION_LIMITS.maxRepairsPerTask;
        // A task whose implementation attempts are used up can only continue its unfinished
        // (timed-out or failed) attempt, as a recovery within the hard limits.
        const recovery = implementationAttempts(task) >= task.maxAttempts ? hardRecoveryFor(task) : null;
        const execution: Extract<NextAction, { kind: 'execute' | 'repair' }> =
          canRepair && last.outcome === 'validation-failed'
            ? { kind: 'repair', taskId: task.id, trigger: 'validation', fromAttempt: last.number, reviewId: null, reopen: false }
            : canRepair && last.outcome === 'review-rejected' && remediation !== undefined
              ? { kind: 'repair', taskId: task.id, trigger: 'review', fromAttempt: last.number, reviewId: remediation.id, reopen: false }
              : recovery !== null
                ? { kind: 'repair', taskId: task.id, trigger: recovery, fromAttempt: last.number, reviewId: null, reopen: false }
                : { kind: 'execute', taskId: task.id };
        const step = await this.executeTask(execution, after, base);
        return { ...step, detail: `Approval ${id} used (one more attempt)${step.detail === null ? '' : `; ${step.detail}`}` };
      }
    }
  }

  private async executeTask(
    action: Extract<NextAction, { kind: 'execute' | 'repair' }>,
    state: ProjectState,
    base: StepResult,
    acknowledgeIntegrityViolation = false,
  ): Promise<StepResult> {
    const { engine, policy, worker, store, signal } = this.options;
    const unsafe = await this.unsafeGitState();
    if (unsafe !== null) {
      return { ...base, outcome: 'refused', detail: unsafe, stop: { reason: 'unsafe-git-state', detail: unsafe, taskId: base.taskId } };
    }

    let origin: AttemptOrigin = { runId: this.runId, repair: null };
    let repairEvidence: string | undefined;
    let repair: StepResult['repair'] = null;
    if (action.kind === 'repair') {
      let current = state;
      if (action.reopen) {
        // Explicit, human-configured policy (not the reviewer) decides remediation; recorded as such,
        // with the blocking findings as the structured requirements the repair must satisfy.
        current = await store.update((latest) =>
          decideReview(
            latest,
            action.taskId,
            'remediation-required',
            `Forge orchestration policy: repair on blocking review (run ${this.runId.slice(0, 8)})`,
            this.clock(),
            'policy',
            { requirements: blockingRequirements(latest, action.reviewId) },
          ),
        );
      }
      const task = current.tasks.find((candidate) => candidate.id === action.taskId)!;
      const evidence = buildRepairEvidence(current, task, action.trigger, action.fromAttempt, action.reviewId, policy);
      const number = nextRepairNumber(task, action.trigger);
      origin = { runId: this.runId, repair: { number, trigger: action.trigger, fromAttempt: action.fromAttempt, reviewId: action.reviewId, evidence: evidence.summary } };
      repairEvidence = evidence.text;
      repair = { number, max: budgetFor(policy, action.trigger), trigger: action.trigger };
    }
    const timeoutMs = workerTimeoutFor(policy, action.kind === 'repair' && action.trigger === 'timeout' ? repair!.number : null);

    let outcome;
    let unavailableRetries = 0;
    for (;;) {
      try {
        outcome = await engine.runTask(action.taskId, {
          worker,
          access: policy.access,
          timeoutMs,
          origin,
          acknowledgeIntegrityViolation,
          ...(repairEvidence === undefined ? {} : { repairEvidence }),
          ...(signal === undefined ? {} : { signal }),
        });
        break;
      } catch (error) {
        const health = await worker.healthCheck().catch(() => undefined);
        if (health === undefined || health.available) {
          throw error;
        }
        // The worker was unavailable before an attempt was recorded (nothing was consumed):
        // a transient outage is retried within the provider-retry budget, after a backoff.
        if (unavailableRetries >= policy.recovery.providerRetries || signal?.aborted === true) {
          const reason = policy.recovery.providerRetries > 0 ? 'provider-retry-exhausted' : 'provider-unavailable';
          const detail = `${describe(error)}${unavailableRetries > 0 ? ` (after ${unavailableRetries} provider retr${unavailableRetries === 1 ? 'y' : 'ies'})` : ''}`;
          return { ...base, repair, outcome: 'refused', detail, stop: { reason, detail, taskId: base.taskId } };
        }
        unavailableRetries += 1;
        this.counters = { ...this.counters, providerRetries: this.counters.providerRetries + 1 };
        await this.wait(Math.min(ORCHESTRATION_LIMITS.maxRetryBackoffMs, policy.recovery.retryBackoffMs * unavailableRetries));
      }
    }

    this.tasksStarted.add(action.taskId);
    const trigger = action.kind === 'repair' ? action.trigger : null;
    this.counters = {
      ...this.counters,
      tasks: this.tasksStarted.size,
      repairs: this.counters.repairs + (trigger === 'validation' || trigger === 'review' ? 1 : 0),
      timeoutRecoveries: this.counters.timeoutRecoveries + (trigger === 'timeout' ? 1 : 0),
      providerRetries: this.counters.providerRetries + (trigger === 'worker-failure' ? 1 : 0),
    };
    const after = outcome.task;
    const last = after?.lastAttempt;
    const finished = outcome.run.result.outcome;
    const step: StepResult = {
      ...base,
      repair,
      timeoutMs,
      attempt: outcome.attempt,
      worker: { id: worker.id, outcome: finished },
      validation: outcome.run.post?.validation?.status ?? null,
      outcome: last?.outcome ?? outcome.run.status,
      detail: last?.note ?? null,
      partialWork: finished === 'success' ? null : last?.changes == null ? null : { files: last.changes.files.length },
    };
    if (outcome.run.persistenceError !== undefined) {
      const detail = `The outcome was not recorded: ${outcome.run.persistenceError.message}`;
      return { ...step, outcome: 'not-recorded', detail, stop: { reason: 'state-not-recorded', detail, taskId: base.taskId } };
    }
    if (!outcome.run.integrity.ok) {
      const detail = `Forge control state changed during the worker run (evidence: ${outcome.run.evidencePath ?? 'unavailable'})`;
      return { ...step, stop: { reason: 'integrity-violation', detail, taskId: base.taskId } };
    }
    if (signal?.aborted === true) {
      return { ...step, stop: { reason: 'cancelled', detail: 'Interrupted by the user during the task; its outcome was recorded truthfully', taskId: base.taskId } };
    }
    // Everything else (validated, validation failed, scope violation, worker failure, awaiting validation)
    // is decided by the next `decideNext` from the recorded state.
    return step;
  }

  private async review(action: Extract<NextAction, { kind: 'review' }>, base: StepResult): Promise<StepResult> {
    const { project, runner, store, policy, signal } = this.options;
    const taskId = action.taskId;
    try {
      const { review } = await reviewTask({
        project,
        runner,
        provider: this.options.reviewer!,
        task: taskId,
        timeoutMs: policy.review.timeoutMs,
        store,
        evidenceRound: action.evidenceRound,
        ...(signal === undefined ? {} : { signal }),
      });
      this.reviewsThisRun.add(review.id);
      this.counters = {
        ...this.counters,
        reviews: this.counters.reviews + 1,
        evidenceReviews: this.counters.evidenceReviews + (action.purpose === 'expand' ? 1 : 0),
        providerRetries: this.counters.providerRetries + (action.purpose === 'retry' ? 1 : 0),
      };
      const why =
        action.purpose === 'expand'
          ? `evidence re-review ${action.evidenceRound} (expanded evidence: ${review.context.files} file(s), ${review.context.bytes} bytes${review.context.truncated ? ', still truncated' : ', complete'})`
          : action.purpose === 'retry'
            ? 'reviewer retry after a failed review'
            : null;
      const found = review.diagnostic ?? (review.findings.length === 0 ? null : `${review.findings.length} finding(s)`);
      const step: StepResult = {
        ...base,
        attempt: review.attempt,
        outcome: review.status,
        review: review.status,
        detail: [why, found].filter((part) => part !== null).join('; ') || null,
      };
      return signal?.aborted === true ? { ...step, stop: { reason: 'cancelled', detail: 'Interrupted by the user during the review', taskId } } : step;
    } catch (error) {
      if (error instanceof IntegrityError) {
        return { ...base, outcome: 'discarded', detail: describe(error), stop: { reason: 'integrity-violation', detail: describe(error), taskId } };
      }
      throw error;
    }
  }

  /**
   * Applies a human's REJECTION of a review-acceptance request as their
   * remediation decision: in one atomic write, the review the request was
   * bound to is decided `remediation-required` by the human (linked to the
   * approval), the rejection reason becomes the remediation requirement
   * verbatim, and the task is reopened through the normal transition (its
   * attempt and validation evidence are kept). The approval itself stays
   * `rejected`. Refused (nothing written) unless the request is still
   * rejected and still bound to the current evidence; once applied the
   * review is decided, so the request can never match or apply again.
   */
  private async applyReviewRejection(action: Extract<NextAction, { kind: 'apply-approval' }>, base: StepResult): Promise<StepResult> {
    const now = this.clock();
    const id = action.approvalId.slice(0, 8);
    let reason = '';
    let applied = false;
    await this.options.store.update((current) => {
      const approval = current.approvals.find((candidate) => candidate.id === action.approvalId);
      if (approval === undefined || approval.type !== 'review-acceptance' || approval.status !== 'rejected' || approval.resolution === null) {
        throw new WorkflowError(`Approval ${id} is no longer a rejected review-acceptance request`);
      }
      if (currentFingerprint(current, approval) !== approval.fingerprint) {
        // Already applied (the review is decided) or the evidence changed: nothing to do.
        return current;
      }
      reason = approval.resolution.reason;
      applied = true;
      return decideReview(current, action.taskId, 'remediation-required', boundedReason(`Rejected by a human through approval ${id}: ${reason}`), now, 'human', {
        approvalId: approval.id,
        requirements: [reason],
      });
    });
    if (!applied) {
      return { ...base, outcome: 'approval-not-applicable', detail: `Approval ${id} no longer matches the task's evidence; nothing was done` };
    }
    return {
      ...base,
      outcome: 'remediation-required',
      detail: `Human rejected review acceptance through approval ${id}. Reason: ${reason} Forge reopened the task for remediation; next: repair it.`,
    };
  }

  /**
   * Asks the AI decision-maker to judge the task's latest review. Forge's
   * rules decide the effect: acceptance (the run continues to the safe
   * commit), remediation (the next decision repairs the task), or
   * escalation (the next decision stops for a human). Never retried within
   * the same step.
   */
  private async decide(action: Extract<NextAction, { kind: 'decide' }>, base: StepResult): Promise<StepResult> {
    const { project, runner, store, policy, signal } = this.options;
    const taskId = action.taskId;
    if (action.retry) {
      this.counters = { ...this.counters, providerRetries: this.counters.providerRetries + 1 };
    }
    try {
      const { decision } = await decideTask({
        project,
        runner,
        provider: this.options.decisionMaker!,
        task: taskId,
        timeoutMs: policy.decision.timeoutMs,
        maxRepairs: policy.repair.maxPerTask,
        store,
        clock: this.clock,
        ...(this.options.generateId === undefined ? {} : { generateId: this.options.generateId }),
        ...(signal === undefined ? {} : { signal }),
      });
      this.decisionsThisRun.add(decision.id);
      this.counters = { ...this.counters, decisions: this.counters.decisions + 1 };
      const outcome = decision.effect === 'accepted' ? 'ai-accepted' : decision.effect === 'remediation-required' ? 'ai-rejected' : 'ai-escalated';
      const verdict = decision.status === 'decided' ? `${decision.verdict}, confidence ${decision.confidence}` : `no usable answer (${decision.status})`;
      const why = decision.policyNote ?? decision.humanReason ?? decision.reason ?? decision.diagnostic ?? '';
      const step: StepResult = { ...base, attempt: decision.attempt, outcome, detail: `AI decision ${decision.id.slice(0, 8)}: ${verdict}${why === '' ? '' : ` — ${why}`}` };
      return signal?.aborted === true ? { ...step, stop: { reason: 'cancelled', detail: 'Interrupted by the user during the AI decision', taskId } } : step;
    } catch (error) {
      if (error instanceof IntegrityError) {
        return { ...base, outcome: 'discarded', detail: describe(error), stop: { reason: 'integrity-violation', detail: describe(error), taskId } };
      }
      throw error;
    }
  }

  private async commit(taskId: string, base: StepResult): Promise<StepResult> {
    try {
      const outcome = await this.options.engine.commitTask(taskId);
      this.counters = { ...this.counters, commits: this.counters.commits + 1 };
      return { ...base, outcome: 'committed', commit: outcome.commit.sha, detail: `${outcome.paths.length} file(s) committed as ${outcome.commit.sha.slice(0, 12)}` };
    } catch (error) {
      // Refused by the M5 safe-commit rules (drift, mixed attribution, hooks…): stop, never force.
      return { ...base, outcome: 'refused', detail: describe(error), stop: { reason: 'commit-refused', detail: describe(error), taskId } };
    }
  }

  /** An expected refusal from an existing service ends the run with its reason; nothing is retried. */
  private failedStep(base: StepResult, error: unknown): StepResult {
    if (!(error instanceof ForgeError)) {
      throw error;
    }
    const aborted = this.options.signal?.aborted === true;
    return {
      ...base,
      outcome: 'refused',
      detail: describe(error),
      stop: aborted ? { reason: 'cancelled', detail: describe(error), taskId: base.taskId } : { reason: 'step-refused', detail: describe(error), taskId: base.taskId },
    };
  }

  /** Waits (for a provider retry's backoff); Ctrl+C ends the wait early. */
  private wait(ms: number): Promise<void> {
    const { signal } = this.options;
    if (ms <= 0 || signal?.aborted === true) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** Conditions under which no worker may run: unresolved merge conflicts. */
  private async unsafeGitState(): Promise<string | null> {
    if (this.options.policy.access !== 'edit') {
      return null;
    }
    const git = await GitClient.create({ runner: this.options.runner, root: this.options.project.layout.root });
    const status = await git.status();
    const unmerged = status.entries.filter((entry) => entry.kind === 'unmerged');
    return unmerged.length === 0
      ? null
      : `The repository has unresolved merge conflicts (${unmerged.slice(0, 3).map((entry) => entry.path).join(', ')})`;
  }

  private async view(): Promise<WorkflowView> {
    return deriveWorkflow(await this.options.store.load(), this.liveness);
  }
}

/** A policy remediation's requirements: the review's blocking findings (their suggested remediation, else their title). */
function blockingRequirements(state: ProjectState, reviewId: string | null): string[] {
  const review = state.taskReviews.find((candidate) => candidate.id === reviewId);
  const blocking = review?.findings.filter((finding) => finding.severity === 'error' || finding.severity === 'critical') ?? [];
  const requirements = blocking
    .slice(0, AI_LIMITS.remediationRequirements)
    .map((finding) => `${finding.title}${finding.remediation === null ? '' : `: ${finding.remediation}`}`.slice(0, AI_LIMITS.requirementText));
  return requirements.length > 0 ? requirements : ['Resolve the blocking review findings'];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The budget of each kind of repair or recovery, for display. */
function budgetFor(policy: OrchestrationPolicy, trigger: RepairTrigger): number {
  switch (trigger) {
    case 'timeout':
      return policy.recovery.timeoutRecoveries;
    case 'worker-failure':
      return policy.recovery.providerRetries;
    default:
      return policy.repair.maxPerTask;
  }
}

/**
 * The recovery a human-approved retry of an exhausted task must take: it can
 * only continue an unfinished (timed-out or failed) attempt, within the hard
 * recovery limits. Null when none applies.
 */
function hardRecoveryFor(task: ProjectState['tasks'][number]): 'timeout' | 'worker-failure' | null {
  const last = task.attempts.at(-1);
  if (last === undefined) {
    return null;
  }
  for (const kind of ['timeout', 'worker-failure'] as const) {
    const limit = kind === 'timeout' ? ORCHESTRATION_LIMITS.maxTimeoutRecoveries : ORCHESTRATION_LIMITS.maxProviderRetries;
    if (RECOVERABLE_OUTCOMES[kind].includes(last.outcome) && attemptsWithTrigger(task, kind) < limit && isRecoveryTrigger(kind)) {
      return kind;
    }
  }
  return null;
}

/** A review decision reason within the state bound (an approval reason may already use all of it). */
function boundedReason(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= AI_LIMITS.reason ? single : `${single.slice(0, AI_LIMITS.reason - 1)}…`;
}
