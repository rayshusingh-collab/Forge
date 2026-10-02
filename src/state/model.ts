/**
 * Persistent orchestration state for one project (`.forge/state.json`).
 *
 * Optional values are explicit `null` so every field is always present on
 * disk. Large outputs (logs, diffs, worker transcripts) must not be stored
 * here. Workflow statuses are owned by Forge's task engine (`src/tasks/`):
 * workers report results, Forge decides transitions.
 */

/**
 * Version history:
 * 1 — Milestone 2: phase, milestones, tasks (with attempts), decisions.
 * 2 — Milestone 3: adds `workerRuns` (migrated from 1 as an empty list).
 * 3 — Milestone 4: task & milestone engine — ordered milestones, tasks with
 *     instructions/dependencies/attempt budgets, attempts linked to worker
 *     runs (migrated from 2; see STATE_MIGRATIONS).
 * 4 — Milestone 5: deterministic validation & Git safety — attempts carry
 *     the Git baseline/changeset, validation evidence, and commit record;
 *     new attempt outcomes (migrated from 3).
 * 5 — Milestone 6: AI planning & review — plan proposals and task reviews
 *     (migrated from 4 as empty lists); `review-rejected` attempt outcome.
 * 6 — Milestone 7: autonomous orchestration — attempts record their
 *     orchestration origin and repair trigger, review decisions record who
 *     decided, and bounded orchestration run history (migrated from 5).
 * 7 — Milestone 8: human control — approval requests, project pause, and
 *     human control events (migrated from 6 as empty / not paused).
 * 8 — Human repair of exhausted tasks: tasks gain `humanRepair` (migrated
 *     from 7 as null).
 * 9 — Auto-decision: structured `remediations` (rebuilt from existing
 *     remediation decisions), `aiDecisions`, review decisions gain
 *     `aiDecisionId`, stored policies gain `decision` (disabled) and run
 *     counters `decisions` (migrated from 8).
 * 10 — Review decisions record the human approval they came through
 *     (`approvalId`, migrated from 9 as null), so a rejected
 *     review-acceptance approval can become traceable remediation.
 */
export const STATE_SCHEMA_VERSION = 10;

/** High-level lifecycle of the work Forge is doing on a project. */
export const PROJECT_PHASES = ['idle', 'planning', 'executing', 'blocked', 'completed'] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

/**
 * Stored milestone status. Transitions (see `src/tasks/transitions.ts`):
 *   pending  -> active     when its first task starts executing
 *   active   -> completed  only when every task is succeeded or cancelled,
 *                          and at least one succeeded
 *   pending | active -> cancelled
 * `completed` and `cancelled` are terminal.
 */
export const MILESTONE_STATUSES = ['pending', 'active', 'completed', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/**
 * Stored task status. Readiness, blocking, retry eligibility, and
 * interruption are derived (never stored) so they cannot go stale.
 *   pending             -> running | cancelled
 *   running             -> succeeded             (worker succeeded and required validation passed)
 *   running             -> awaiting-validation   (worker succeeded; validation not completed)
 *   running             -> failed                (worker failed, validation failed, violation, or recovery)
 *   awaiting-validation -> succeeded             (validation passed on re-run, or audited human override)
 *   awaiting-validation -> failed                (validation failed on re-run, or rejected)
 *   failed              -> running               (retry, while attempts remain)
 *   failed              -> succeeded             (exhausted, repaired by a human, fresh required validation
 *                                                 passed; recorded in `humanRepair`, never as an attempt)
 *   failed              -> cancelled
 * `succeeded` and `cancelled` are terminal.
 */
export const TASK_STATUSES = ['pending', 'running', 'awaiting-validation', 'succeeded', 'failed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Outcome of one task attempt, from the task engine's point of view.
 * Worker-level details live in the linked worker run.
 * - `running`: in progress (or interrupted — see recovery)
 * - `awaiting-validation`: the worker invocation succeeded; deterministic
 *   validation has not (yet) produced a verdict
 * - `validated`: required deterministic validation passed (Forge's evidence)
 * - `validation-failed`: required validation failed or timed out
 * - `overridden`: a human explicitly accepted it without passing validation (audited)
 * - `accepted`: Milestone 4 manual acceptance (kept for existing state only)
 * - `rejected`: a human rejected it
 * - `scope-violation`: changes appeared outside the permitted scope
 * - `review-rejected`: validated, but a human decided (after an AI review)
 *   that remediation is required; the validation evidence is kept
 * - `failed`, `timeout`, `cancelled`, `unavailable`, `invalid-output`,
 *   `integrity-violation`: the invocation did not succeed (same as the run status)
 * - `interrupted`: Forge stopped before recording an outcome; set by recovery
 */
export const ATTEMPT_OUTCOMES = [
  'running',
  'awaiting-validation',
  'accepted',
  'rejected',
  'failed',
  'timeout',
  'cancelled',
  'unavailable',
  'invalid-output',
  'integrity-violation',
  'interrupted',
  'validated',
  'validation-failed',
  'overridden',
  'scope-violation',
  'review-rejected',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * Overall result of a validation run, over the REQUIRED checks, by priority:
 * cancelled > configuration-error > execution-error > timed-out > failed > passed.
 * Optional checks never change it.
 */
export const VALIDATION_STATUSES = [
  'passed',
  'failed',
  'timed-out',
  'cancelled',
  'configuration-error',
  'execution-error',
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Result of one check. `skipped` checks were not run because validation was cancelled. */
export const CHECK_STATUSES = [...VALIDATION_STATUSES, 'skipped'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const FILE_CHANGE_KINDS = ['added', 'modified', 'deleted', 'renamed'] as const;
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];

/**
 * `task`: the path was clean before the task, so the whole change is the task's.
 * `mixed`: the path already had uncommitted changes and changed again; Forge
 * cannot tell which part is whose.
 */
export const CHANGE_ATTRIBUTIONS = ['task', 'mixed'] as const;
export type ChangeAttribution = (typeof CHANGE_ATTRIBUTIONS)[number];

/** Bounds on stored Git and validation evidence. */
export const EVIDENCE_LIMITS = {
  baselineEntries: 500,
  changedFiles: 500,
  pathList: 50,
  path: 1_000,
  checks: 20,
  outputExcerpt: 500,
  diagnostic: 500,
} as const;

export const DECISION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/**
 * Final or in-progress status of a worker run: the worker outcomes, plus
 * `running`, plus `integrity-violation` — Forge's verdict when protected
 * control state (`.forge/`) changed during the run, which overrides
 * whatever the worker reported — plus `interrupted`, set when a run that
 * never recorded an outcome is recovered.
 */
export const WORKER_RUN_STATUSES = [
  'running',
  'success',
  'failed',
  'timeout',
  'cancelled',
  'unavailable',
  'invalid-output',
  'integrity-violation',
  'interrupted',
] as const;
export type WorkerRunStatus = (typeof WORKER_RUN_STATUSES)[number];

/** How a worker run was started: `forge worker run` or a task execution. */
export const WORKER_RUN_TRIGGERS = ['manual', 'task'] as const;
export type WorkerRunTrigger = (typeof WORKER_RUN_TRIGGERS)[number];

export const WORKER_ACCESS_MODES = ['read-only', 'edit'] as const;
export type WorkerAccessMode = (typeof WORKER_ACCESS_MODES)[number];

/** Bounds keeping worker run records small; enforced on write and on load. */
export const WORKER_RUN_LIMITS = {
  /** Most recent manual runs retained; task runs are kept with their task. */
  retainedRuns: 100,
  taskExcerpt: 200,
  summary: 1_000,
  diagnostic: 500,
} as const;

/** Bounds on the task engine's own records. */
export const TASK_LIMITS = {
  title: 200,
  description: 4_000,
  instruction: 20_000,
  context: 50_000,
  note: 1_000,
  dependencies: 50,
  maxAttempts: 10,
  defaultMaxAttempts: 3,
} as const;

/**
 * Bounded record of one worker invocation. Holds metadata only: never
 * transcripts, raw output, or secrets. Task executions link here from the
 * task attempt (`TaskAttempt.runId`); this is the single record of the
 * invocation itself.
 */
export interface WorkerRunRecord {
  /** Request ID (UUID) shared with the worker result. */
  readonly id: string;
  /** Worker identifier, e.g. `claude-code`. */
  readonly worker: string;
  readonly trigger: WorkerRunTrigger;
  readonly access: WorkerAccessMode;
  /** Task this run executed, for `task` runs. */
  readonly taskId: string | null;
  /** Attempt number within that task, for `task` runs. */
  readonly attempt: number | null;
  /** Truncated excerpt of the instruction. */
  readonly task: string;
  /** Working directory relative to the project root (`.` for the root). */
  readonly workingDirectory: string;
  readonly status: WorkerRunStatus;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  /** Truncated worker summary. */
  readonly summary: string | null;
  /** Truncated reason for a non-success outcome. */
  readonly diagnostic: string | null;
}

/** A path that had uncommitted changes before the task started. */
export interface BaselineEntry {
  readonly path: string;
  /** Index / worktree status letters from `git status`. */
  readonly index: string;
  readonly worktree: string;
  readonly indexHash: string | null;
  /** `sha256:<hex>`, `link:<hex>`, `dir`, or `missing`. */
  readonly fingerprint: string;
}

/** Repository state captured before an edit-enabled task ran. */
export interface GitBaseline {
  /** null in a repository without commits. */
  readonly head: string | null;
  /** null when HEAD is detached. */
  readonly branch: string | null;
  readonly entries: readonly BaselineEntry[];
  /** More dirty paths existed than could be stored; later attribution is unreliable. */
  readonly truncated: boolean;
  readonly capturedAt: string;
}

export interface FileChange {
  readonly path: string;
  readonly change: FileChangeKind;
  /** Original path of a staged rename. */
  readonly from: string | null;
  readonly attribution: ChangeAttribution;
  /** Working tree fingerprint when the changeset was captured. */
  readonly fingerprint: string;
}

/** What changed during a task, relative to its baseline. */
export interface ChangeSummary {
  readonly baseline: GitBaseline;
  readonly head: string | null;
  readonly branch: string | null;
  readonly files: readonly FileChange[];
  readonly truncated: boolean;
  /** Pre-existing dirty paths the task left untouched. */
  readonly preexistingUntouched: number;
  /** Paths whose staged (index) state changed during the task. */
  readonly indexChanged: readonly string[];
  /** Changed paths outside the permitted scope (working directory, or protected paths). */
  readonly outOfScope: readonly string[];
  readonly capturedAt: string;
}

export interface CheckResultRecord {
  readonly id: string;
  readonly required: boolean;
  readonly status: CheckStatus;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** Resolved program that ran. */
  readonly executable: string | null;
  /** Tail excerpts, stored only for checks that did not pass. */
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly outputTruncated: boolean;
  readonly diagnostic: string | null;
}

/** Evidence from one deterministic validation run. Excerpts only; never full output. */
export interface ValidationRecord {
  readonly status: ValidationStatus;
  /** SHA-256 of the validation profile that was used. */
  readonly profileHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly checks: readonly CheckResultRecord[];
}

/** A local commit Forge created for the attempt's attributed changes. */
export interface CommitRecord {
  readonly sha: string;
  readonly paths: number;
  readonly committedAt: string;
}

/** The Forge process executing an attempt; used to detect interrupted executions. */
export interface AttemptExecutor {
  readonly pid: number;
  readonly host: string;
}

/** What caused Forge to run a repair attempt. */
export const REPAIR_TRIGGERS = ['validation', 'review'] as const;
export type RepairTrigger = (typeof REPAIR_TRIGGERS)[number];

/**
 * A repair attempt: Forge re-ran the task's implementer with bounded
 * evidence of why the previous attempt was not acceptable.
 */
export interface RepairRecord {
  /** 1-based count of repairs of this task (the repair budget is per task). */
  readonly number: number;
  readonly trigger: RepairTrigger;
  /** The attempt whose evidence triggered the repair (always the previous one). */
  readonly fromAttempt: number;
  /** The review that triggered a review repair. */
  readonly reviewId: string | null;
  /** Bounded summary of the triggering evidence (not the full output). */
  readonly evidence: string;
}

/** Set when an orchestration run (`forge run`) started the attempt; null for manual runs. */
export interface AttemptOrigin {
  readonly runId: string;
  readonly repair: RepairRecord | null;
}

export interface TaskAttempt {
  /** 1-based and sequential within its task; every attempt counts toward the budget. */
  readonly number: number;
  /** The worker run that performed this attempt. */
  readonly runId: string;
  readonly outcome: AttemptOutcome;
  readonly executor: AttemptExecutor;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /** Rejection reason, recovery note, or similar (bounded). */
  readonly note: string | null;
  /** Git baseline and changeset for edit-enabled attempts. */
  readonly changes: ChangeSummary | null;
  /** Latest deterministic validation evidence for this attempt. */
  readonly validation: ValidationRecord | null;
  readonly commit: CommitRecord | null;
  readonly origin: AttemptOrigin | null;
}

/**
 * A human repaired an exhausted task by hand and Forge accepted it
 * (`forge task accept-repair`). It is NOT an attempt: no worker ran, the
 * attempt budget is untouched, and every attempt keeps its original outcome.
 * Acceptance rests on Forge's own evidence, gathered at acceptance time:
 * a fresh run of the required validation checks that passed, and the
 * changeset measured against the task's recorded Git baseline.
 */
export interface HumanRepairRecord {
  /** The attempt after which the human repaired the task (always its last attempt). */
  readonly afterAttempt: number;
  readonly reason: string;
  readonly by: 'human';
  readonly acceptedAt: string;
  /** The last attempt ended in an integrity or scope violation, which the human explicitly acknowledged. */
  readonly acknowledgedViolation: boolean;
  /** Everything changed since the task's baseline: the workers' attempts plus the human repair. */
  readonly changes: ChangeSummary;
  /** The validation Forge ran at acceptance; always `passed`. */
  readonly validation: ValidationRecord;
  /** The local commit `forge task commit` created for these changes, if any. */
  readonly commit: CommitRecord | null;
}

export interface TaskRecord {
  readonly id: string;
  readonly milestoneId: string;
  /** Position within the milestone (1-based, unique within it). */
  readonly order: number;
  readonly title: string;
  /** What the worker is asked to do. Untrusted text; never shell syntax or configuration. */
  readonly instruction: string;
  readonly context: string | null;
  readonly status: TaskStatus;
  /** Tasks that must have succeeded before this one may run. */
  readonly dependsOn: readonly string[];
  readonly maxAttempts: number;
  readonly attempts: readonly TaskAttempt[];
  /** Why the task was cancelled, if it was. */
  readonly cancelReason: string | null;
  /** Set only when a human-repaired exhausted task was accepted; the task is then succeeded. */
  readonly humanRepair: HumanRepairRecord | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MilestoneRecord {
  readonly id: string;
  /** Position among milestones (1-based, unique). */
  readonly order: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: MilestoneStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A question or approval that needs a human. */
export interface DecisionRecord {
  readonly id: string;
  readonly taskId: string | null;
  readonly question: string;
  readonly status: DecisionStatus;
  readonly resolution: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

/** Plan proposal lifecycle: proposed -> applied | rejected (both terminal). */
export const PLAN_STATUSES = ['proposed', 'applied', 'rejected'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Bounds on AI planning and review records. */
export const AI_LIMITS = {
  goal: 2_000,
  planMilestones: 10,
  planTasks: 50,
  planDependencies: 20,
  planListItems: 20,
  planItemText: 500,
  planTitle: 200,
  planDescription: 2_000,
  planInstruction: 4_000,
  planContext: 4_000,
  planSuggestedValidation: 10,
  proposals: 200,
  reviewFindings: 30,
  reviewSummary: 2_000,
  findingTitle: 200,
  findingDetail: 2_000,
  findingRemediation: 1_000,
  findingPaths: 10,
  reviewsPerTask: 20,
  reason: 1_000,
  diagnostic: 500,
  /** Requirements per remediation record, and length of each. */
  remediationRequirements: 10,
  requirementText: 1_000,
  /** AI decisions retained per task (oldest escalated ones are dropped first; applied ones are kept). */
  aiDecisionsPerTask: 40,
  /** Decision attempts on one review before Forge stops asking and leaves it to a human. */
  aiDecisionsPerReview: 3,
  decisionReason: 2_000,
  assessmentNote: 500,
} as const;

export interface PlanMilestone {
  /** Proposal-local ID, e.g. `m1`. */
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
}

export interface PlanTask {
  /** Proposal-local ID, e.g. `t1`. */
  readonly id: string;
  readonly milestone: string;
  readonly title: string;
  readonly instruction: string;
  readonly context: string | null;
  /** Proposal-local IDs of tasks listed EARLIER in the plan. */
  readonly dependsOn: readonly string[];
  /** Informational only: never becomes a validation command. */
  readonly suggestedValidation: readonly string[];
}

/** A planner's structured output, after Forge validated it. */
export interface PlanDocument {
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly milestones: readonly PlanMilestone[];
  readonly tasks: readonly PlanTask[];
  readonly risks: readonly string[];
  readonly notes: string | null;
}

/** Bounded metadata about an AI call (never prompts, responses, or credentials). */
export interface AiCallMetadata {
  /** Provider/adapter ID, e.g. `claude-code`. */
  readonly provider: string;
  readonly model: string | null;
  readonly durationMs: number;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** Summary of the bounded context an AI role received. */
export interface ContextSummary {
  readonly files: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface PlanMapping {
  readonly proposalId: string;
  readonly forgeId: string;
}

/**
 * An AI-generated plan awaiting a human decision. It is not work: only
 * `forge plan apply` turns it into milestones and tasks.
 */
export interface PlanProposal {
  readonly id: string;
  readonly goal: string;
  readonly status: PlanStatus;
  readonly plan: PlanDocument;
  readonly call: AiCallMetadata;
  readonly context: ContextSummary;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  /** Human reason for a rejection. */
  readonly reason: string | null;
  /** Proposal ID -> Forge ID, set when applied. */
  readonly appliedMilestones: readonly PlanMapping[];
  readonly appliedTasks: readonly PlanMapping[];
}

/**
 * Review status, derived by Forge from finding severities (never taken
 * from the model's own verdict):
 *   clear             no findings above `info`
 *   concerns          at least one `warning`
 *   blocking-concerns at least one `error` or `critical`
 * or the reason no review was obtained.
 */
export const REVIEW_STATUSES = [
  'clear',
  'concerns',
  'blocking-concerns',
  'unavailable',
  'failed',
  'timeout',
  'cancelled',
  'invalid-output',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FINDING_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const REVIEW_RECOMMENDATIONS = ['accept', 'revise', 'reject'] as const;
export type ReviewRecommendation = (typeof REVIEW_RECOMMENDATIONS)[number];

export const REVIEW_CONFIDENCE = ['low', 'medium', 'high'] as const;
export type ReviewConfidence = (typeof REVIEW_CONFIDENCE)[number];

export interface ReviewFinding {
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly paths: readonly string[];
  readonly remediation: string | null;
}

/** `accepted`: implementation stands despite the review. `remediation-required`: the task is reopened. */
export const REVIEW_DECISIONS = ['accepted', 'remediation-required'] as const;
export type ReviewDecisionKind = (typeof REVIEW_DECISIONS)[number];

/**
 * Who decided: a human (`forge task review-accept|review-reject`), Forge
 * applying an explicit, human-configured orchestration policy (review-driven
 * repair), or the AI decision-maker in a human-enabled auto-decision run
 * (`ai`, always linked to its `AiDecisionRecord`). Never the reviewer itself.
 */
export const REVIEW_DECIDERS = ['human', 'policy', 'ai'] as const;
export type ReviewDecider = (typeof REVIEW_DECIDERS)[number];

export interface ReviewDecision {
  readonly kind: ReviewDecisionKind;
  readonly reason: string;
  readonly decidedAt: string;
  readonly by: ReviewDecider;
  /** The AI decision this applies; set exactly when `by` is `ai`. */
  readonly aiDecisionId: string | null;
  /**
   * The review-acceptance approval through which a human decided, when they
   * did so by approving (accepted) or rejecting (remediation-required) a
   * request Forge made; null otherwise. Only ever set when `by` is `human`.
   */
  readonly approvalId: string | null;
}

/**
 * Structured remediation required by a `remediation-required` review
 * decision (one record per such decision). It stays `open` across attempts
 * and restarts until a later attempt's review is accepted, and every later
 * worker attempt, review and AI decision is given its requirements.
 */
export const REMEDIATION_STATUSES = ['open', 'satisfied'] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];

export interface RemediationRecord {
  readonly id: string;
  readonly taskId: string;
  /** The attempt whose review required it. */
  readonly fromAttempt: number;
  readonly reviewId: string;
  readonly source: ReviewDecider;
  /** What must be observably true of a later attempt. */
  readonly requirements: readonly string[];
  readonly createdAt: string;
  readonly status: RemediationStatus;
  readonly resolvedAt: string | null;
  /** The later review whose acceptance satisfied it. */
  readonly resolvedByReviewId: string | null;
}

/** What the AI decision-maker answered. */
export const AI_DECISION_VERDICTS = ['accept', 'reject', 'escalate'] as const;
export type AiDecisionVerdict = (typeof AI_DECISION_VERDICTS)[number];

/** Whether a usable answer was obtained (`decided`) or why not. Anything but `decided` escalates. */
export const AI_DECISION_STATUSES = ['decided', 'unavailable', 'failed', 'timeout', 'cancelled', 'invalid-output'] as const;
export type AiDecisionStatus = (typeof AI_DECISION_STATUSES)[number];

/**
 * What Forge did with it, after applying its own rules: the review was
 * accepted, remediation was required (task reopened), or a human was asked.
 */
export const AI_DECISION_EFFECTS = ['accepted', 'remediation-required', 'escalated'] as const;
export type AiDecisionEffect = (typeof AI_DECISION_EFFECTS)[number];

export const FINDING_ASSESSMENTS = ['resolved', 'unresolved', 'not-applicable', 'acceptable'] as const;
export type FindingAssessmentStatus = (typeof FINDING_ASSESSMENTS)[number];

export const REQUIREMENT_ASSESSMENTS = ['satisfied', 'unsatisfied', 'unverifiable'] as const;
export type RequirementAssessmentStatus = (typeof REQUIREMENT_ASSESSMENTS)[number];

export interface FindingAssessment {
  /** 1-based index into the review's findings. */
  readonly finding: number;
  readonly status: FindingAssessmentStatus;
  readonly note: string;
}

export interface RequirementAssessment {
  /** Label of an open requirement as presented (`R1`, `R2`, …). */
  readonly requirement: string;
  readonly status: RequirementAssessmentStatus;
  readonly evidence: string;
}

/**
 * One AI decision-maker judgment on a completed review. Advisory input to
 * Forge, never authority: `effect` records what Forge actually did after its
 * deterministic rules (which may escalate a verdict, never upgrade one).
 */
export interface AiDecisionRecord {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly reviewId: string;
  readonly status: AiDecisionStatus;
  readonly verdict: AiDecisionVerdict | null;
  readonly confidence: ReviewConfidence | null;
  readonly reason: string | null;
  /** Remediation the decision-maker required (reject only). */
  readonly requiredActions: readonly string[];
  /** Why a human must decide (escalate only). */
  readonly humanReason: string | null;
  readonly findingAssessments: readonly FindingAssessment[];
  readonly requirementAssessments: readonly RequirementAssessment[];
  readonly effect: AiDecisionEffect;
  /** Why Forge's rules changed the verdict's effect (e.g. low-confidence acceptance escalated), if they did. */
  readonly policyNote: string | null;
  readonly call: AiCallMetadata;
  readonly context: ContextSummary;
  readonly diagnostic: string | null;
  readonly createdAt: string;
}

/** An advisory AI review of one validated task attempt. Never a validation result. */
export interface TaskReview {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly status: ReviewStatus;
  /** The model's own recommendation; advisory. */
  readonly recommendation: ReviewRecommendation | null;
  readonly confidence: ReviewConfidence | null;
  readonly summary: string | null;
  readonly findings: readonly ReviewFinding[];
  readonly call: AiCallMetadata;
  readonly context: ContextSummary;
  readonly diagnostic: string | null;
  readonly createdAt: string;
  readonly decision: ReviewDecision | null;
}

/**
 * Hard bounds on orchestration. Policy values above these are refused (never
 * clamped silently); there is no "unlimited".
 */
export const ORCHESTRATION_LIMITS = {
  maxTasks: 50,
  maxSteps: 200,
  maxRepairsPerTask: 5,
  retainedRuns: 50,
  eventsPerRun: 200,
  eventDetail: 300,
  stopDetail: 1_000,
  repairEvidenceSummary: 500,
  providerName: 100,
} as const;

/** Behavior when an AI review did not produce a usable result (unavailable, timeout, invalid output…). */
export const REVIEW_FAILURE_POLICIES = ['stop', 'continue'] as const;
export type ReviewFailurePolicy = (typeof REVIEW_FAILURE_POLICIES)[number];

/** Behavior when a completed review has warnings (`concerns`). */
export const REVIEW_CONCERN_POLICIES = ['stop', 'continue'] as const;
export type ReviewConcernPolicy = (typeof REVIEW_CONCERN_POLICIES)[number];

/**
 * Everything `forge run` may do automatically. Built only from Forge
 * defaults and explicit human input (CLI options); never from AI output,
 * repository content, or validation output.
 */
export interface OrchestrationPolicy {
  /** Distinct tasks a run may execute (initial attempts and repairs of new tasks). */
  readonly maxTasks: number;
  /** Workflow steps a run may perform. */
  readonly maxSteps: number;
  /** Worker access for task attempts. `read-only` tasks always stop for manual validation. */
  readonly access: WorkerAccessMode;
  readonly worker: string;
  readonly workerTimeoutMs: number;
  readonly repair: {
    /** Repair automatically after required deterministic validation failed. */
    readonly onValidationFailure: boolean;
    /** Repair automatically after an AI review reported blocking concerns (or a human required remediation). */
    readonly onBlockingReview: boolean;
    /** Repairs per task, across runs; also bounded by the task's own attempt budget. */
    readonly maxPerTask: number;
  };
  readonly review: {
    readonly enabled: boolean;
    /** Provider ID for the reviewer role, when enabled. */
    readonly reviewer: string | null;
    readonly timeoutMs: number;
    readonly onConcerns: ReviewConcernPolicy;
    readonly onFailure: ReviewFailurePolicy;
  };
  /**
   * Auto-decision: when a completed review would otherwise stop for a human
   * decision, the AI decision-maker judges it and Forge applies the verdict
   * under its own stricter rules (see `src/decision/`). Off by default.
   */
  readonly decision: {
    readonly enabled: boolean;
    /** Provider ID for the decision-maker role, when enabled. */
    readonly provider: string | null;
    readonly timeoutMs: number;
  };
  /** Create local commits of validated tasks' own changes (M5 safe-commit rules). Never pushes. */
  readonly autoCommit: boolean;
}

export const ORCHESTRATION_RUN_MODES = ['run', 'step'] as const;
export type OrchestrationRunMode = (typeof ORCHESTRATION_RUN_MODES)[number];

/**
 * `running` while its Forge process owns the orchestration lease;
 * `stopped` once it recorded a stop reason; `interrupted` when a later run
 * found it running without a live owner (it never recorded how it ended).
 */
export const ORCHESTRATION_RUN_STATUSES = ['running', 'stopped', 'interrupted'] as const;
export type OrchestrationRunStatus = (typeof ORCHESTRATION_RUN_STATUSES)[number];

export const ORCHESTRATION_ACTIONS = ['execute', 'repair', 'review', 'decide', 'commit', 'complete-milestone', 'apply-approval', 'stop'] as const;
export type OrchestrationAction = (typeof ORCHESTRATION_ACTIONS)[number];

/** Why an orchestration run stopped. Labels, categories and guidance live in `src/orchestration/stop-reason.ts`. */
export const STOP_REASONS = [
  'complete',
  'no-work',
  'step-done',
  'limit-steps',
  'limit-tasks',
  'cancelled',
  'interrupted-task',
  'task-running',
  'manual-validation-required',
  'integrity-acknowledgement-required',
  'scope-acknowledgement-required',
  'repair-not-permitted',
  'repair-budget-exhausted',
  'retry-exhausted',
  'worker-failed',
  'review-decision-required',
  'review-remediation-required',
  'reviewer-unavailable',
  'decision-escalated',
  'decision-overruled',
  'decision-maker-unavailable',
  'decision-maker-invalid-output',
  'decision-maker-timeout',
  'commit-refused',
  'unsafe-git-state',
  'provider-unavailable',
  'blocked',
  'milestone-incomplete',
  'no-runnable-task',
  'integrity-violation',
  'state-not-recorded',
  'lease-lost',
  'step-refused',
  'error',
  'paused',
  'approval-rejected',
  'review-rejection-blocked',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface OrchestrationEvent {
  readonly at: string;
  /** 1-based step number within the run. */
  readonly step: number;
  readonly action: OrchestrationAction;
  readonly taskId: string | null;
  readonly milestoneId: string | null;
  readonly attempt: number | null;
  /** Short machine-readable outcome, e.g. `validated`, `validation-failed`, `clear`, `committed`. */
  readonly outcome: string;
  readonly detail: string | null;
}

export interface OrchestrationCounters {
  readonly steps: number;
  readonly tasks: number;
  readonly repairs: number;
  readonly reviews: number;
  /** AI decision-maker calls. */
  readonly decisions: number;
  readonly commits: number;
  readonly milestones: number;
}

export interface OrchestrationStop {
  readonly reason: StopReason;
  readonly detail: string | null;
  readonly taskId: string | null;
}

/** Bounded record of one `forge run` / `forge run step` invocation. Never prompts, diffs, or outputs. */
export interface OrchestrationRun {
  readonly id: string;
  readonly mode: OrchestrationRunMode;
  readonly status: OrchestrationRunStatus;
  readonly owner: AttemptExecutor;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly policy: OrchestrationPolicy;
  /** SHA-256 of the canonical policy JSON. */
  readonly policyHash: string;
  readonly counters: OrchestrationCounters;
  /** Most recent events (older ones are dropped beyond the bound). */
  readonly events: readonly OrchestrationEvent[];
  readonly eventsDropped: number;
  readonly stop: OrchestrationStop | null;
}

/**
 * What a human approval authorizes. Each is single-purpose:
 * - `review-acceptance`          accept a task's AI review despite concerns / blocking concerns
 * - `violation-acknowledgement`  retry a task after an integrity or scope violation (acknowledged)
 * - `task-retry`                 one more attempt of a failed task the policy would not retry
 * - `interrupted-recovery`       mark an interrupted execution as failed (never re-runs it)
 * - `lease-recovery`             forced removal of an orchestration lease whose owner cannot be proven dead
 */
export const APPROVAL_TYPES = ['review-acceptance', 'violation-acknowledgement', 'task-retry', 'interrupted-recovery', 'lease-recovery'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

/**
 * pending      requested by Forge, waiting for a human
 * approved     a human approved it; not yet used
 * rejected     a human rejected it (terminal; Forge stops while it applies)
 * consumed     Forge used the approval exactly once (terminal)
 * invalidated  the evidence it was bound to changed before use (terminal)
 */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'consumed', 'invalidated'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const APPROVAL_LIMITS = {
  retained: 500,
  reason: 1_000,
  evidenceLines: 12,
  evidenceLine: 300,
  requestedAction: 300,
  boundTo: 300,
} as const;

/** Only humans resolve approvals; the field exists so the record says so explicitly. */
export interface ApprovalResolution {
  readonly decision: ApprovalDecision;
  readonly reason: string;
  readonly by: 'human';
  readonly at: string;
}

/** A request for a human decision, bound by fingerprint to the evidence it authorizes. */
export interface ApprovalRecord {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: ApprovalStatus;
  /** The task it concerns (null for lease recovery). */
  readonly taskId: string | null;
  /** The orchestration run that requested it, or the lease owner's run for lease recovery. */
  readonly runId: string | null;
  /** Why Forge stopped (bounded). */
  readonly reason: string;
  /** Bounded summary of the evidence (IDs, statuses, short excerpts). */
  readonly evidence: readonly string[];
  /** What approving allows Forge to do. */
  readonly requestedAction: string;
  /** Human-readable description of what the fingerprint covers. */
  readonly boundTo: string;
  /** SHA-256 of the evidence it is bound to; any change makes the approval unusable. */
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly resolution: ApprovalResolution | null;
  readonly consumedAt: string | null;
  readonly consumedByRunId: string | null;
  readonly invalidatedAt: string | null;
  readonly invalidationReason: string | null;
}

/** A paused project refuses autonomous execution and AI/worker invocations until a human resumes it. */
export interface PauseState {
  readonly reason: string;
  readonly pausedAt: string;
  readonly by: 'human';
}

export const CONTROL_EVENT_KINDS = ['paused', 'resumed', 'lease-recovered', 'config-set', 'config-reset'] as const;
export type ControlEventKind = (typeof CONTROL_EVENT_KINDS)[number];

export const CONTROL_LIMITS = { retainedEvents: 500, reason: 1_000, detail: 300 } as const;

/** A human control action that has no other authoritative record. */
export interface ControlEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: ControlEventKind;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly by: 'human';
}

export interface ProjectState {
  readonly schemaVersion: typeof STATE_SCHEMA_VERSION;
  readonly projectId: string;
  /** Incremented on every save; used to detect concurrent modification. */
  readonly revision: number;
  readonly phase: ProjectPhase;
  readonly milestones: readonly MilestoneRecord[];
  readonly tasks: readonly TaskRecord[];
  readonly decisions: readonly DecisionRecord[];
  /** Worker invocations, oldest first. */
  readonly workerRuns: readonly WorkerRunRecord[];
  /** AI plan proposals; only applied proposals became work. */
  readonly planProposals: readonly PlanProposal[];
  /** Advisory AI reviews of validated task attempts. */
  readonly taskReviews: readonly TaskReview[];
  /** Orchestration runs, oldest first (bounded). */
  readonly orchestrationRuns: readonly OrchestrationRun[];
  /** Human approval requests and their resolutions (bounded). */
  readonly approvals: readonly ApprovalRecord[];
  /** Non-null while a human has paused the project. */
  readonly pause: PauseState | null;
  /** Human control actions (pause, resume, lease recovery, config changes), oldest first (bounded). */
  readonly controlEvents: readonly ControlEvent[];
  /** Structured remediation required by review decisions; never deleted. */
  readonly remediations: readonly RemediationRecord[];
  /** AI decision-maker judgments, oldest first (bounded per task; applied ones are kept). */
  readonly aiDecisions: readonly AiDecisionRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** State for a newly registered project: no work planned, nothing pending. */
export function createInitialState(projectId: string, now: Date): ProjectState {
  const timestamp = now.toISOString();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    projectId,
    revision: 1,
    phase: 'idle',
    milestones: [],
    tasks: [],
    decisions: [],
    workerRuns: [],
    planProposals: [],
    taskReviews: [],
    orchestrationRuns: [],
    approvals: [],
    pause: null,
    controlEvents: [],
    remediations: [],
    aiDecisions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
