import { ObjectReader, SchemaViolation, isPlainObject } from '../core/validation.ts';
import { checkWorkflowInvariants } from './invariants.ts';
import {
  ATTEMPT_OUTCOMES,
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
} from './model.ts';
import type {
  AttemptExecutor,
  DecisionRecord,
  MilestoneRecord,
  ProjectState,
  TaskAttempt,
  TaskRecord,
  ValidationCheckSummary,
  ValidationSummary,
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
    'validation',
  ]);
  const attempt: TaskAttempt = {
    number: r.integer('number', { min: 1 }),
    runId: r.id('runId'),
    outcome: r.oneOf('outcome', ATTEMPT_OUTCOMES),
    executor: r.field('executor', decodeExecutor),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.nullableTimestamp('finishedAt'),
    note: r.nullableString('note', NOTE_RULES),
    validation: r.nullable('validation', decodeValidationSummary),
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
