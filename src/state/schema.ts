import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import {
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
} from './model.ts';
import type {
  AttemptRecord,
  DecisionRecord,
  MilestoneRecord,
  ProjectState,
  TaskRecord,
  ValidationCheckSummary,
  ValidationSummary,
  WorkerRunRecord,
} from './model.ts';
import type { Migration } from './versioning.ts';

const TITLE_RULES = { maxLength: 200 } as const;
const TEXT_RULES = { maxLength: 4_000 } as const;
const NAME_RULES = { maxLength: 100 } as const;

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
};

/** Structural and referential validation of a current-version state document. */
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
    milestones: r.array('milestones', decodeMilestone),
    tasks: r.array('tasks', decodeTask),
    decisions: r.array('decisions', decodeDecision),
    workerRuns: r.array('workerRuns', decodeWorkerRun, 1_000),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
  checkReferences(state);
  return state;
}

function decodeMilestone(value: unknown, path: string): MilestoneRecord {
  const r = new ObjectReader(value, path, ['id', 'title', 'description', 'status', 'createdAt', 'updatedAt']);
  return {
    id: r.id('id'),
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
    'title',
    'description',
    'status',
    'attempts',
    'createdAt',
    'updatedAt',
  ]);
  const task: TaskRecord = {
    id: r.id('id'),
    milestoneId: r.nullableId('milestoneId'),
    title: r.string('title', TITLE_RULES),
    description: r.nullableString('description', TEXT_RULES),
    status: r.oneOf('status', TASK_STATUSES),
    attempts: r.array('attempts', decodeAttempt, 1_000),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
  task.attempts.forEach((attempt, index) => {
    if (attempt.number !== index + 1) {
      throw new SchemaViolation(`${path}.attempts[${index}].number`, `must be ${index + 1} (attempts are sequential)`);
    }
  });
  return task;
}

function decodeAttempt(value: unknown, path: string): AttemptRecord {
  const r = new ObjectReader(value, path, [
    'number',
    'status',
    'worker',
    'startedAt',
    'finishedAt',
    'validation',
    'summary',
  ]);
  const attempt: AttemptRecord = {
    number: r.integer('number', { min: 1 }),
    status: r.oneOf('status', ATTEMPT_STATUSES),
    worker: r.nullableString('worker', NAME_RULES),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.nullableTimestamp('finishedAt'),
    validation: r.nullable('validation', decodeValidationSummary),
    summary: r.nullableString('summary', TEXT_RULES),
  };
  if ((attempt.status === 'running') !== (attempt.finishedAt === null)) {
    throw new SchemaViolation(`${path}.finishedAt`, 'must be null exactly when the attempt is running');
  }
  return attempt;
}

function decodeValidationSummary(value: unknown, path: string): ValidationSummary {
  const r = new ObjectReader(value, path, ['status', 'checks', 'completedAt']);
  return {
    status: r.oneOf('status', VALIDATION_STATUSES),
    checks: r.array('checks', decodeValidationCheck, 100),
    completedAt: r.timestamp('completedAt'),
  };
}

function decodeValidationCheck(value: unknown, path: string): ValidationCheckSummary {
  const r = new ObjectReader(value, path, ['name', 'status']);
  return { name: r.string('name', NAME_RULES), status: r.oneOf('status', VALIDATION_STATUSES) };
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
  const running = run.status === 'running';
  if (running !== (run.finishedAt === null) || running !== (run.durationMs === null)) {
    throw new SchemaViolation(`${path}.finishedAt`, 'finishedAt and durationMs must be null exactly when the run is running');
  }
  return run;
}

function decodeNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SchemaViolation(path, 'must be a non-negative integer');
  }
  return value;
}

/** IDs must be unique and every reference must point at an existing record. */
function checkReferences(state: ProjectState): void {
  const milestoneIds = uniqueIds(state.milestones, 'milestones');
  const taskIds = uniqueIds(state.tasks, 'tasks');
  uniqueIds(state.decisions, 'decisions');
  uniqueIds(state.workerRuns, 'workerRuns');

  state.tasks.forEach((task, index) => {
    if (task.milestoneId !== null && !milestoneIds.has(task.milestoneId)) {
      throw new SchemaViolation(`tasks[${index}].milestoneId`, `references unknown milestone "${task.milestoneId}"`);
    }
  });
  state.decisions.forEach((decision, index) => {
    if (decision.taskId !== null && !taskIds.has(decision.taskId)) {
      throw new SchemaViolation(`decisions[${index}].taskId`, `references unknown task "${decision.taskId}"`);
    }
  });
}

function uniqueIds(records: readonly { readonly id: string }[], path: string): Set<string> {
  const seen = new Set<string>();
  records.forEach((record, index) => {
    if (seen.has(record.id)) {
      throw new SchemaViolation(`${path}[${index}].id`, `duplicates "${record.id}"`);
    }
    seen.add(record.id);
  });
  return seen;
}
