import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import {
  ATTEMPT_STATUSES,
  DECISION_STATUSES,
  MILESTONE_STATUSES,
  PROJECT_PHASES,
  STATE_SCHEMA_VERSION,
  TASK_STATUSES,
  VALIDATION_STATUSES,
} from './model.ts';
import type {
  AttemptRecord,
  DecisionRecord,
  MilestoneRecord,
  ProjectState,
  TaskRecord,
  ValidationCheckSummary,
  ValidationSummary,
} from './model.ts';

const TITLE_RULES = { maxLength: 200 } as const;
const TEXT_RULES = { maxLength: 4_000 } as const;
const NAME_RULES = { maxLength: 100 } as const;

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

/** IDs must be unique and every reference must point at an existing record. */
function checkReferences(state: ProjectState): void {
  const milestoneIds = uniqueIds(state.milestones, 'milestones');
  const taskIds = uniqueIds(state.tasks, 'tasks');
  uniqueIds(state.decisions, 'decisions');

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
