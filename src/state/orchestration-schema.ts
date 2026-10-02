import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import {
  ORCHESTRATION_ACTIONS,
  ORCHESTRATION_LIMITS,
  ORCHESTRATION_RUN_MODES,
  ORCHESTRATION_RUN_STATUSES,
  REPAIR_TRIGGERS,
  REVIEW_CONCERN_POLICIES,
  REVIEW_FAILURE_POLICIES,
  STOP_REASONS,
  WORKER_ACCESS_MODES,
} from './model.ts';
import type {
  AttemptExecutor,
  AttemptOrigin,
  OrchestrationCounters,
  OrchestrationEvent,
  OrchestrationPolicy,
  OrchestrationRun,
  OrchestrationStop,
  RecoveryPolicy,
  RepairRecord,
} from './model.ts';

/**
 * Decoders for orchestration records (schema version 6): attempt origins,
 * repair records, and bounded orchestration run history. Strict like the
 * rest of the state schema: unknown fields are rejected.
 */

/** Hard ceiling for any stored timeout (24 h), matching worker requests. */
const MAX_TIMEOUT_MS = 86_400_000;
const PROVIDER_RULES = { maxLength: ORCHESTRATION_LIMITS.providerName } as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function decodeAttemptOrigin(value: unknown, path: string): AttemptOrigin {
  const r = new ObjectReader(value, path, ['runId', 'repair']);
  return { runId: r.id('runId'), repair: r.nullable('repair', decodeRepairRecord) };
}

function decodeRepairRecord(value: unknown, path: string): RepairRecord {
  const r = new ObjectReader(value, path, ['number', 'trigger', 'fromAttempt', 'reviewId', 'evidence']);
  const repair: RepairRecord = {
    // Numbered per kind: implementation repairs, timeout recoveries, provider retries.
    number: r.integer('number', { min: 1, max: Math.max(ORCHESTRATION_LIMITS.maxRepairsPerTask, ORCHESTRATION_LIMITS.maxTimeoutRecoveries, ORCHESTRATION_LIMITS.maxProviderRetries) }),
    trigger: r.oneOf('trigger', REPAIR_TRIGGERS),
    fromAttempt: r.integer('fromAttempt', { min: 1 }),
    reviewId: r.nullableId('reviewId'),
    evidence: r.string('evidence', { maxLength: ORCHESTRATION_LIMITS.repairEvidenceSummary }),
  };
  if ((repair.trigger === 'review') !== (repair.reviewId !== null)) {
    throw new SchemaViolation(`${path}.reviewId`, 'must be set exactly for review repairs');
  }
  return repair;
}

export function decodeOrchestrationRun(value: unknown, path: string): OrchestrationRun {
  const r = new ObjectReader(value, path, [
    'id',
    'mode',
    'status',
    'owner',
    'startedAt',
    'finishedAt',
    'policy',
    'policyHash',
    'counters',
    'events',
    'eventsDropped',
    'stop',
  ]);
  const run: OrchestrationRun = {
    id: r.id('id'),
    mode: r.oneOf('mode', ORCHESTRATION_RUN_MODES),
    status: r.oneOf('status', ORCHESTRATION_RUN_STATUSES),
    owner: r.field('owner', decodeOwner),
    startedAt: r.timestamp('startedAt'),
    finishedAt: r.nullableTimestamp('finishedAt'),
    policy: r.field('policy', decodeOrchestrationPolicy),
    policyHash: r.string('policyHash', { pattern: HASH_PATTERN, patternDescription: 'a SHA-256 hex digest' }),
    counters: r.field('counters', decodeCounters),
    events: r.array('events', decodeEvent, ORCHESTRATION_LIMITS.eventsPerRun),
    eventsDropped: r.integer('eventsDropped', { min: 0 }),
    stop: r.nullable('stop', decodeStop),
  };
  if ((run.status === 'running') !== (run.finishedAt === null)) {
    throw new SchemaViolation(`${path}.finishedAt`, 'must be null exactly while the run is running');
  }
  if ((run.status === 'stopped') !== (run.stop !== null)) {
    throw new SchemaViolation(`${path}.stop`, 'must be recorded exactly when the run stopped');
  }
  return run;
}

function decodeOwner(value: unknown, path: string): AttemptExecutor {
  const r = new ObjectReader(value, path, ['pid', 'host']);
  return { pid: r.integer('pid', { min: 0 }), host: r.string('host', { maxLength: 100 }) };
}

/** Decodes a policy and enforces the hard limits, so stored policy can never exceed them. */
export function decodeOrchestrationPolicy(value: unknown, path: string): OrchestrationPolicy {
  const r = new ObjectReader(value, path, ['maxTasks', 'maxSteps', 'access', 'worker', 'workerTimeoutMs', 'repair', 'review', 'decision', 'autoCommit', 'autonomous', 'recovery']);
  const policy: OrchestrationPolicy = {
    maxTasks: r.integer('maxTasks', { min: 1, max: ORCHESTRATION_LIMITS.maxTasks }),
    maxSteps: r.integer('maxSteps', { min: 1, max: ORCHESTRATION_LIMITS.maxSteps }),
    access: r.oneOf('access', WORKER_ACCESS_MODES),
    worker: r.string('worker', PROVIDER_RULES),
    workerTimeoutMs: r.integer('workerTimeoutMs', { min: 1, max: MAX_TIMEOUT_MS }),
    repair: r.field('repair', (item, itemPath) => {
      const repair = new ObjectReader(item, itemPath, ['onValidationFailure', 'onBlockingReview', 'maxPerTask']);
      return {
        onValidationFailure: repair.field('onValidationFailure', decodeBoolean),
        onBlockingReview: repair.field('onBlockingReview', decodeBoolean),
        maxPerTask: repair.integer('maxPerTask', { min: 0, max: ORCHESTRATION_LIMITS.maxRepairsPerTask }),
      };
    }),
    review: r.field('review', (item, itemPath) => {
      const review = new ObjectReader(item, itemPath, ['enabled', 'reviewer', 'timeoutMs', 'onConcerns', 'onFailure']);
      const decoded = {
        enabled: review.field('enabled', decodeBoolean),
        reviewer: review.nullableString('reviewer', PROVIDER_RULES),
        timeoutMs: review.integer('timeoutMs', { min: 1, max: MAX_TIMEOUT_MS }),
        onConcerns: review.oneOf('onConcerns', REVIEW_CONCERN_POLICIES),
        onFailure: review.oneOf('onFailure', REVIEW_FAILURE_POLICIES),
      };
      if (decoded.enabled !== (decoded.reviewer !== null)) {
        throw new SchemaViolation(`${itemPath}.reviewer`, 'must be set exactly when review is enabled');
      }
      return decoded;
    }),
    decision: r.field('decision', (item, itemPath) => {
      const decision = new ObjectReader(item, itemPath, ['enabled', 'provider', 'timeoutMs']);
      const decoded = {
        enabled: decision.field('enabled', decodeBoolean),
        provider: decision.nullableString('provider', PROVIDER_RULES),
        timeoutMs: decision.integer('timeoutMs', { min: 1, max: MAX_TIMEOUT_MS }),
      };
      if (decoded.enabled !== (decoded.provider !== null)) {
        throw new SchemaViolation(`${itemPath}.provider`, 'must be set exactly when auto-decision is enabled');
      }
      return decoded;
    }),
    autoCommit: r.field('autoCommit', decodeBoolean),
    autonomous: r.field('autonomous', decodeBoolean),
    recovery: r.field('recovery', decodeRecoveryPolicy),
  };
  if (policy.recovery.maxWorkerTimeoutMs < policy.workerTimeoutMs) {
    throw new SchemaViolation(`${path}.recovery.maxWorkerTimeoutMs`, 'must be at least the normal worker timeout');
  }
  // The decision-maker judges completed reviews, so it is meaningless (and refused) without review.
  if (policy.decision.enabled && !policy.review.enabled) {
    throw new SchemaViolation(`${path}.decision`, 'auto-decision requires AI review to be enabled');
  }
  return policy;
}

function decodeRecoveryPolicy(value: unknown, path: string): RecoveryPolicy {
  const r = new ObjectReader(value, path, ['timeoutRecoveries', 'timeoutIncreaseMs', 'maxWorkerTimeoutMs', 'providerRetries', 'retryBackoffMs', 'evidenceReviews']);
  return {
    timeoutRecoveries: r.integer('timeoutRecoveries', { min: 0, max: ORCHESTRATION_LIMITS.maxTimeoutRecoveries }),
    timeoutIncreaseMs: r.integer('timeoutIncreaseMs', { min: 0, max: MAX_TIMEOUT_MS }),
    maxWorkerTimeoutMs: r.integer('maxWorkerTimeoutMs', { min: 1, max: MAX_TIMEOUT_MS }),
    providerRetries: r.integer('providerRetries', { min: 0, max: ORCHESTRATION_LIMITS.maxProviderRetries }),
    retryBackoffMs: r.integer('retryBackoffMs', { min: 0, max: ORCHESTRATION_LIMITS.maxRetryBackoffMs }),
    evidenceReviews: r.integer('evidenceReviews', { min: 0, max: ORCHESTRATION_LIMITS.maxEvidenceReviews }),
  };
}

function decodeCounters(value: unknown, path: string): OrchestrationCounters {
  const r = new ObjectReader(value, path, [
    'steps',
    'tasks',
    'repairs',
    'reviews',
    'decisions',
    'commits',
    'milestones',
    'timeoutRecoveries',
    'providerRetries',
    'evidenceReviews',
    'humanInterventions',
  ]);
  return {
    steps: r.integer('steps', { min: 0, max: ORCHESTRATION_LIMITS.maxSteps }),
    tasks: r.integer('tasks', { min: 0, max: ORCHESTRATION_LIMITS.maxTasks }),
    repairs: r.integer('repairs', { min: 0 }),
    reviews: r.integer('reviews', { min: 0 }),
    decisions: r.integer('decisions', { min: 0 }),
    commits: r.integer('commits', { min: 0 }),
    milestones: r.integer('milestones', { min: 0 }),
    timeoutRecoveries: r.integer('timeoutRecoveries', { min: 0 }),
    providerRetries: r.integer('providerRetries', { min: 0 }),
    evidenceReviews: r.integer('evidenceReviews', { min: 0 }),
    humanInterventions: r.integer('humanInterventions', { min: 0 }),
  };
}

function decodeEvent(value: unknown, path: string): OrchestrationEvent {
  const r = new ObjectReader(value, path, ['at', 'step', 'action', 'taskId', 'milestoneId', 'attempt', 'outcome', 'detail']);
  return {
    at: r.timestamp('at'),
    step: r.integer('step', { min: 0, max: ORCHESTRATION_LIMITS.maxSteps }),
    action: r.oneOf('action', ORCHESTRATION_ACTIONS),
    taskId: r.nullableId('taskId'),
    milestoneId: r.nullableId('milestoneId'),
    attempt: r.nullable('attempt', (item, itemPath) => {
      if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1) {
        throw new SchemaViolation(itemPath, 'must be a positive integer');
      }
      return item;
    }),
    outcome: r.string('outcome', { maxLength: 60, pattern: /^[a-z][a-z0-9-]*$/, patternDescription: 'a lower-case outcome code' }),
    detail: r.nullableString('detail', { maxLength: ORCHESTRATION_LIMITS.eventDetail }),
  };
}

function decodeStop(value: unknown, path: string): OrchestrationStop {
  const r = new ObjectReader(value, path, ['reason', 'detail', 'taskId']);
  return {
    reason: r.oneOf('reason', STOP_REASONS),
    detail: r.nullableString('detail', { maxLength: ORCHESTRATION_LIMITS.stopDetail }),
    taskId: r.nullableId('taskId'),
  };
}

function decodeBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new SchemaViolation(path, 'must be true or false');
  }
  return value;
}
