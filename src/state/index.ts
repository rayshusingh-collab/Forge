export { MAX_DOCUMENT_BYTES, acquireFileLock, readJsonDocument, serializeJson, withFileLock, writeFileAtomic } from './files.ts';
export type { HeldFileLock } from './files.ts';
export { describeDependencyProblem, findCycle, findDependencyProblem } from './graph.ts';
export type { DependencyNode, DependencyProblem } from './graph.ts';
export { FAILED_ATTEMPT_OUTCOMES, checkWorkflowInvariants, runStatusForAttempt, statusImpliedByAttempts } from './invariants.ts';
export {
  ATTEMPT_OUTCOMES,
  CHANGE_ATTRIBUTIONS,
  CHECK_STATUSES,
  EVIDENCE_LIMITS,
  FILE_CHANGE_KINDS,
  DECISION_STATUSES,
  MILESTONE_STATUSES,
  PROJECT_PHASES,
  STATE_SCHEMA_VERSION,
  TASK_LIMITS,
  TASK_STATUSES,
  VALIDATION_STATUSES,
  WORKER_ACCESS_MODES,
  WORKER_RUN_LIMITS,
  WORKER_RUN_STATUSES,
  WORKER_RUN_TRIGGERS,
  createInitialState,
} from './model.ts';
export type {
  AttemptExecutor,
  AttemptOutcome,
  DecisionRecord,
  DecisionStatus,
  MilestoneRecord,
  MilestoneStatus,
  ProjectPhase,
  ProjectState,
  TaskAttempt,
  TaskRecord,
  TaskStatus,
  BaselineEntry,
  ChangeAttribution,
  ChangeSummary,
  CheckResultRecord,
  CheckStatus,
  CommitRecord,
  FileChange,
  FileChangeKind,
  GitBaseline,
  ValidationRecord,
  ValidationStatus,
  WorkerAccessMode,
  WorkerRunRecord,
  WorkerRunStatus,
  WorkerRunTrigger,
} from './model.ts';
export { STATE_MIGRATIONS, decodeProjectState } from './schema.ts';
export { DEFAULT_LOCK_TIMEOUT_MS, StateStore } from './state-store.ts';
export type { StateLease, StateStoreOptions } from './state-store.ts';
export { UnsupportedVersionError, readSchemaVersion, upgradeDocument } from './versioning.ts';
export type { Migration } from './versioning.ts';
