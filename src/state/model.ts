/**
 * Persistent orchestration state for one project (`.forge/state.json`).
 *
 * These records are the storage foundation for later milestones; nothing in
 * Milestone 2 creates milestones, tasks, attempts, or decisions. Optional
 * values are explicit `null` so every field is always present on disk.
 * Large outputs (logs, diffs, worker transcripts) must not be stored here.
 */

export const STATE_SCHEMA_VERSION = 1;

/** High-level lifecycle of the work Forge is doing on a project. */
export const PROJECT_PHASES = ['idle', 'planning', 'executing', 'blocked', 'completed'] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

export const MILESTONE_STATUSES = ['pending', 'in-progress', 'completed', 'cancelled'] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** Mirrors the task lifecycle in docs/ARCHITECTURE.md. */
export const TASK_STATUSES = [
  'pending',
  'running',
  'validating',
  'reviewing',
  'retrying',
  'blocked',
  'completed',
  'failed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ATTEMPT_STATUSES = ['running', 'succeeded', 'failed', 'cancelled'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const VALIDATION_STATUSES = ['passed', 'failed'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export const DECISION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export interface ValidationCheckSummary {
  /** e.g. `typecheck`, `test`. */
  readonly name: string;
  readonly status: ValidationStatus;
}

/** Outcome of validating one attempt. Holds verdicts only, never raw output. */
export interface ValidationSummary {
  readonly status: ValidationStatus;
  readonly checks: readonly ValidationCheckSummary[];
  readonly completedAt: string;
}

export interface AttemptRecord {
  /** 1-based and sequential within its task. */
  readonly number: number;
  readonly status: AttemptStatus;
  /** Worker that performed the attempt, e.g. `claude-code`. */
  readonly worker: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly validation: ValidationSummary | null;
  /** Short human-readable outcome or failure reason. */
  readonly summary: string | null;
}

export interface TaskRecord {
  readonly id: string;
  readonly milestoneId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly attempts: readonly AttemptRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MilestoneRecord {
  readonly id: string;
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
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
