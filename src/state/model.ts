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
 */
export const STATE_SCHEMA_VERSION = 4;

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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
