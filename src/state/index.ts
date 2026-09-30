export { MAX_DOCUMENT_BYTES, acquireFileLock, readJsonDocument, serializeJson, withFileLock, writeFileAtomic } from './files.ts';
export type { HeldFileLock } from './files.ts';
export {
  ATTEMPT_STATUSES,
  DECISION_STATUSES,
  MILESTONE_STATUSES,
  PROJECT_PHASES,
  STATE_SCHEMA_VERSION,
  TASK_STATUSES,
  VALIDATION_STATUSES,
  WORKER_ACCESS_MODES,
  WORKER_RUN_LIMITS,
  WORKER_RUN_STATUSES,
  WORKER_RUN_TRIGGERS,
  createInitialState,
} from './model.ts';
export type {
  AttemptRecord,
  AttemptStatus,
  DecisionRecord,
  DecisionStatus,
  MilestoneRecord,
  MilestoneStatus,
  ProjectPhase,
  ProjectState,
  TaskRecord,
  TaskStatus,
  ValidationCheckSummary,
  ValidationStatus,
  ValidationSummary,
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
