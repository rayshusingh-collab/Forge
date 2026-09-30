import { ObjectReader, SchemaViolation, isPlainObject } from '../core/validation.ts';
import { checkWorkflowInvariants } from './invariants.ts';
import {
  ATTEMPT_OUTCOMES,
  CHANGE_ATTRIBUTIONS,
  CHECK_STATUSES,
  DECISION_STATUSES,
  EVIDENCE_LIMITS,
  FILE_CHANGE_KINDS,
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
} from './model.ts';
import type {
  AttemptExecutor,
  DecisionRecord,
  MilestoneRecord,
  ProjectState,
  TaskAttempt,
  BaselineEntry,
  ChangeSummary,
  CheckResultRecord,
  CommitRecord,
  FileChange,
  GitBaseline,
  TaskRecord,
  ValidationRecord,
  WorkerRunRecord,
} from './model.ts';
import type { Migration } from './versioning.ts';

const TITLE_RULES = { maxLength: TASK_LIMITS.title } as const;
const TEXT_RULES = { maxLength: TASK_LIMITS.description } as const;
const NAME_RULES = { maxLength: 100 } as const;
const NOTE_RULES = { maxLength: TASK_LIMITS.note } as const;

/**
 * Migrations from older state versions, keyed by the version they upgrade
 * from. Each returns the document at the next version.
 */
export const STATE_MIGRATIONS: Readonly<Record<number, Migration>> = {
  // 1 -> 2: standalone worker runs were introduced; version 1 state has none.
  1: (document) => {
    if (Object.hasOwn(document, 'workerRuns')) {
      throw new SchemaViolation('workerRuns', 'is not a recognised field in schema version 1');
    }
    return { ...document, schemaVersion: 2, workerRuns: [] };
  },
  // 2 -> 3: the task engine. Milestones gain an explicit order and the
  // `in-progress` status becomes `active`; worker runs gain task links.
  // Version 2 tasks were placeholders no Forge command ever created and
  // cannot be mapped faithfully, so any that exist are refused, not guessed.
  2: (document) => {
    const tasks = document['tasks'];
    if (!Array.isArray(tasks)) {
      throw new SchemaViolation('tasks', 'must be an array');
    }
    if (tasks.length > 0) {
      throw new SchemaViolation(
        'tasks',
        'contains schema version 2 tasks, which cannot be migrated to version 3 automatically; ' +
          'remove them from state.json (keeping a backup) or restore a version 2 Forge',
      );
    }
    return {
      ...document,
      schemaVersion: 3,
      milestones: arrayOfObjects(document['milestones'], 'milestones').map((milestone, index) => ({
        ...milestone,
        order: index + 1,
        status: milestone['status'] === 'in-progress' ? 'active' : milestone['status'],
      })),
      workerRuns: arrayOfObjects(document['workerRuns'], 'workerRuns').map((run) => {
        if (Object.hasOwn(run, 'taskId') || Object.hasOwn(run, 'attempt')) {
          throw new SchemaViolation('workerRuns', 'contain fields not recognised in schema version 2');
        }
        return { ...run, taskId: null, attempt: null };
      }),
    };
  },
  // 3 -> 4: deterministic validation. Attempts gain `changes` and `commit`
  // (none existed before). Version 3's `validation` field was reserved and
  // never written by Forge; a non-null value cannot be mapped and is refused.
  3: (document) => ({
    ...document,
    schemaVersion: 4,
    tasks: arrayOfObjects(document['tasks'], 'tasks').map((task, taskIndex) => ({
      ...task,
      attempts: arrayOfObjects(task['attempts'], `tasks[${taskIndex}].attempts`).map((attempt, attemptIndex) => {
        if (attempt['validation'] !== null || Object.hasOwn(attempt, 'changes') || Object.hasOwn(attempt, 'commit')) {
          throw new SchemaViolation(
            `tasks[${taskIndex}].attempts[${attemptIndex}]`,
            'contains validation data that schema version 3 never recorded; it cannot be migrated',
          );
        }
        return { ...attempt, changes: null, validation: null, commit: null };
      }),
    })),
  }),
};

function arrayOfObjects(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new SchemaViolation(path, 'must be an array');
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new SchemaViolation(`${path}[${index}]`, 'must be an object');
    }
    return item;
  });
}

/**
 * Structural validation of a current-version state document, followed by
 * the workflow invariants (dependency graph, ordering, status/attempt
 * consistency, attempt/run links).
 */
export function decodeProjectState(raw: unknown): ProjectState {
  const r = new ObjectReader(raw, '', [
    'schemaVersion',
    'projectId',
    'revision',
    'phase',
    'milestones',
    'tasks',
    'decisions',
    'workerRuns',
    'createdAt',
    'updatedAt',
  ]);
  if (r.integer('schemaVersion') !== STATE_SCHEMA_VERSION) {
    throw new SchemaViolation('schemaVersion', `must be ${STATE_SCHEMA_VERSION}`);
  }
  const state: ProjectState = {
    schemaVersion: STATE_SCHEMA_VERSION,
    projectId: r.id('projectId'),
    revision: r.integer('revision', { min: 1 }),
    phase: r.oneOf('phase', PROJECT_PHASES),
    milestones: r.array('milestones', decodeMilestone, 1_000),
    tasks: r.array('tasks', decodeTask, 5_000),
    decisions: r.array('decisions', decodeDecision),
    workerRuns: r.array('workerRuns', decodeWorkerRun, 20_000),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
  checkWorkflowInvariants(state);
  return state;
}

function decodeMilestone(value: unknown, path: string): MilestoneRecord {
  const r = new ObjectReader(value, path, ['id', 'order', 'title', 'description', 'status', 'createdAt', 'updatedAt']);
  return {
    id: r.id('id'),
    order: r.integer('order', { min: 1 }),
    title: r.string('title', TITLE_RULES),
    description: r.nullableString('description', TEXT_RULES),
    status: r.oneOf('status', MILESTONE_STATUSES),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
}

function decodeTask(value: unknown, path: string): TaskRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'milestoneId',
    'order',
    'title',
    'instruction',
    'context',
    'status',
    'dependsOn',
    'maxAttempts',
    'attempts',
    'cancelReason',
    'createdAt',
    'updatedAt',
  ]);
  return {
    id: r.id('id'),
    milestoneId: r.id('milestoneId'),
    order: r.integer('order', { min: 1 }),
    title: r.string('title', TITLE_RULES),
    instruction: r.string('instruction', { maxLength: TASK_LIMITS.instruction }),
    context: r.nullableString('context', { maxLength: TASK_LIMITS.context }),
    status: r.oneOf('status', TASK_STATUSES),
    dependsOn: r.array('dependsOn', decodeIdItem, TASK_LIMITS.dependencies),
    maxAttempts: r.integer('maxAttempts', { min: 1, max: TASK_LIMITS.maxAttempts }),
    attempts: r.array('attempts', decodeAttempt, TASK_LIMITS.maxAttempts),
    cancelReason: r.nullableString('cancelReason', NOTE_RULES),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
}

function decodeIdItem(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new SchemaViolation(path, 'must be a task identifier');
  }
  return value;
}

function decodeAttempt(value: unknown, path: string): TaskAttempt {
  const r = new ObjectReader(value, path, [
    'number',
    'runId',
    'outcome',
    'executor',
    'startedAt',
    'finishedAt',
    'note',
    'changes',
    'validation',
    'commit',
  ]);
  const attempt: TaskAttempt = {
    number: r.integer('number', { min: 1 }),
    runId: r.id('runId'),
    outcome: r.oneOf('outcome', ATTEMPT_OUTCOMES),
    executor: r.field('executor', decodeExecutor),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.nullableTimestamp('finishedAt'),
    note: r.nullableString('note', NOTE_RULES),
    changes: r.nullable('changes', decodeChangeSummary),
    validation: r.nullable('validation', decodeValidationRecord),
    commit: r.nullable('commit', decodeCommit),
  };
  if ((attempt.outcome === 'running') !== (attempt.finishedAt === null)) {
    throw new SchemaViolation(`${path}.finishedAt`, 'must be null exactly when the attempt is running');
  }
  return attempt;
}

function decodeExecutor(value: unknown, path: string): AttemptExecutor {
  const r = new ObjectReader(value, path, ['pid', 'host']);
  return { pid: r.integer('pid', { min: 0 }), host: r.string('host', NAME_RULES) };
}

const PATH_RULES = { maxLength: EVIDENCE_LIMITS.path } as const;
const HASH_PATTERN = { pattern: /^[0-9a-f]{40,64}$/, patternDescription: 'a hexadecimal object hash' } as const;
const EXCERPT_RULES = { minLength: 0, maxLength: EVIDENCE_LIMITS.outputExcerpt } as const;

function decodeValidationRecord(value: unknown, path: string): ValidationRecord {
  const r = new ObjectReader(value, path, ['status', 'profileHash', 'startedAt', 'finishedAt', 'checks']);
  return {
    status: r.oneOf('status', VALIDATION_STATUSES),
    profileHash: r.string('profileHash', { pattern: /^[0-9a-f]{64}$/, patternDescription: 'a SHA-256 hash' }),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.timestamp('finishedAt'),
    checks: r.array('checks', decodeCheckResult, EVIDENCE_LIMITS.checks),
  };
}

function decodeCheckResult(value: unknown, path: string): CheckResultRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'required',
    'status',
    'exitCode',
    'durationMs',
    'executable',
    'stdout',
    'stderr',
    'outputTruncated',
    'diagnostic',
  ]);
  return {
    id: r.string('id', NAME_RULES),
    required: r.field('required', decodeBoolean),
    status: r.oneOf('status', CHECK_STATUSES),
    exitCode: r.nullable('exitCode', (item, itemPath) => decodeInteger(item, itemPath)),
    durationMs: r.nullable('durationMs', (item, itemPath) => decodeNonNegativeInteger(item, itemPath)),
    executable: r.nullableString('executable', PATH_RULES),
    stdout: r.nullableString('stdout', EXCERPT_RULES),
    stderr: r.nullableString('stderr', EXCERPT_RULES),
    outputTruncated: r.field('outputTruncated', decodeBoolean),
    diagnostic: r.nullableString('diagnostic', { maxLength: EVIDENCE_LIMITS.diagnostic }),
  };
}

function decodeChangeSummary(value: unknown, path: string): ChangeSummary {
  const r = new ObjectReader(value, path, [
    'baseline',
    'head',
    'branch',
    'files',
    'truncated',
    'preexistingUntouched',
    'indexChanged',
    'outOfScope',
    'capturedAt',
  ]);
  return {
    baseline: r.field('baseline', decodeBaseline),
    head: r.nullableString('head', HASH_PATTERN),
    branch: r.nullableString('branch', PATH_RULES),
    files: r.array('files', decodeFileChange, EVIDENCE_LIMITS.changedFiles),
    truncated: r.field('truncated', decodeBoolean),
    preexistingUntouched: r.integer('preexistingUntouched', { min: 0 }),
    indexChanged: r.array('indexChanged', decodeRepoPath, EVIDENCE_LIMITS.pathList),
    outOfScope: r.array('outOfScope', decodeRepoPath, EVIDENCE_LIMITS.pathList),
    capturedAt: r.timestamp('capturedAt'),
  };
}

function decodeBaseline(value: unknown, path: string): GitBaseline {
  const r = new ObjectReader(value, path, ['head', 'branch', 'entries', 'truncated', 'capturedAt']);
  return {
    head: r.nullableString('head', HASH_PATTERN),
    branch: r.nullableString('branch', PATH_RULES),
    entries: r.array('entries', decodeBaselineEntry, EVIDENCE_LIMITS.baselineEntries),
    truncated: r.field('truncated', decodeBoolean),
    capturedAt: r.timestamp('capturedAt'),
  };
}

function decodeBaselineEntry(value: unknown, path: string): BaselineEntry {
  const r = new ObjectReader(value, path, ['path', 'index', 'worktree', 'indexHash', 'fingerprint']);
  return {
    path: r.field('path', decodeRepoPath),
    index: r.string('index', { maxLength: 1 }),
    worktree: r.string('worktree', { maxLength: 1 }),
    indexHash: r.nullableString('indexHash', HASH_PATTERN),
    fingerprint: r.field('fingerprint', decodeFingerprint),
  };
}

function decodeFileChange(value: unknown, path: string): FileChange {
  const r = new ObjectReader(value, path, ['path', 'change', 'from', 'attribution', 'fingerprint']);
  return {
    path: r.field('path', decodeRepoPath),
    change: r.oneOf('change', FILE_CHANGE_KINDS),
    from: r.nullable('from', decodeRepoPath),
    attribution: r.oneOf('attribution', CHANGE_ATTRIBUTIONS),
    fingerprint: r.field('fingerprint', decodeFingerprint),
  };
}

function decodeCommit(value: unknown, path: string): CommitRecord {
  const r = new ObjectReader(value, path, ['sha', 'paths', 'committedAt']);
  return {
    sha: r.string('sha', HASH_PATTERN),
    paths: r.integer('paths', { min: 1 }),
    committedAt: r.timestamp('committedAt'),
  };
}

/** Repository-relative, "/"-separated, never absolute or escaping. */
function decodeRepoPath(value: unknown, path: string): string {
  if (typeof value !== 'string' || value === '' || value.length > EVIDENCE_LIMITS.path || value.includes('\0')) {
    throw new SchemaViolation(path, 'must be a repository-relative path');
  }
  if (/^[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
    throw new SchemaViolation(path, 'must be a repository-relative path');
  }
  return value;
}

function decodeFingerprint(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^(sha256:[0-9a-f]{64}|link:[0-9a-f]{64}|dir|missing)$/.test(value)) {
    throw new SchemaViolation(path, 'must be a content fingerprint');
  }
  return value;
}

function decodeBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaViolation(path, 'must be true or false');
  }
  return value;
}

function decodeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SchemaViolation(path, 'must be an integer');
  }
  return value;
}

function decodeDecision(value: unknown, path: string): DecisionRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'taskId',
    'question',
    'status',
    'resolution',
    'createdAt',
    'resolvedAt',
  ]);
  const decision: DecisionRecord = {
    id: r.id('id'),
    taskId: r.nullableId('taskId'),
    question: r.string('question', TEXT_RULES),
    status: r.oneOf('status', DECISION_STATUSES),
    resolution: r.nullableString('resolution', TEXT_RULES),
    createdAt: r.timestamp('createdAt'),
    resolvedAt: r.nullableTimestamp('resolvedAt'),
  };
  if ((decision.status === 'pending') !== (decision.resolvedAt === null)) {
    throw new SchemaViolation(`${path}.resolvedAt`, 'must be null exactly when the decision is pending');
  }
  return decision;
}

function decodeWorkerRun(value: unknown, path: string): WorkerRunRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'worker',
    'trigger',
    'access',
    'taskId',
    'attempt',
    'task',
    'workingDirectory',
    'status',
    'startedAt',
    'finishedAt',
    'durationMs',
    'summary',
    'diagnostic',
  ]);
  const run: WorkerRunRecord = {
    id: r.id('id'),
    worker: r.string('worker', NAME_RULES),
    trigger: r.oneOf('trigger', WORKER_RUN_TRIGGERS),
    access: r.oneOf('access', WORKER_ACCESS_MODES),
    taskId: r.nullableId('taskId'),
    attempt: r.nullable('attempt', (item, itemPath) => decodePositiveInteger(item, itemPath)),
    task: r.string('task', { maxLength: WORKER_RUN_LIMITS.taskExcerpt }),
    workingDirectory: r.string('workingDirectory', { maxLength: 1_000 }),
    status: r.oneOf('status', WORKER_RUN_STATUSES),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.nullableTimestamp('finishedAt'),
    durationMs: r.nullable('durationMs', (item, itemPath) => decodeNonNegativeInteger(item, itemPath)),
    summary: r.nullableString('summary', { maxLength: WORKER_RUN_LIMITS.summary }),
    diagnostic: r.nullableString('diagnostic', { maxLength: WORKER_RUN_LIMITS.diagnostic }),
  };
  // Stored relative to the project root with "/" separators; never absolute or escaping.
  const segments = run.workingDirectory.split('/');
  const absoluteLike = /^[\\/]/.test(run.workingDirectory) || /^[A-Za-z]:/.test(run.workingDirectory);
  if (absoluteLike || run.workingDirectory.includes('\\') || segments.includes('..')) {
    throw new SchemaViolation(`${path}.workingDirectory`, 'must be a relative path inside the project using "/"');
  }
  // `interrupted` runs never recorded a finish; every other non-running status did.
  const open = run.status === 'running' || run.status === 'interrupted';
  if (open !== (run.durationMs === null) || (run.status === 'running') !== (run.finishedAt === null)) {
    throw new SchemaViolation(`${path}.finishedAt`, 'finishedAt and durationMs are inconsistent with the run status');
  }
  const linked = run.trigger === 'task';
  if (linked !== (run.taskId !== null) || linked !== (run.attempt !== null)) {
    throw new SchemaViolation(`${path}.taskId`, 'taskId and attempt must be set exactly for task runs');
  }
  return run;
}

function decodeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaViolation(path, 'must be a non-negative integer');
  }
  return value;
}

function decodePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SchemaViolation(path, 'must be a positive integer');
  }
  return value;
}
