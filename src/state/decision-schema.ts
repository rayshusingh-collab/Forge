import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import {
  AI_DECISION_EFFECTS,
  AI_DECISION_STATUSES,
  AI_DECISION_VERDICTS,
  AI_LIMITS,
  FINDING_ASSESSMENTS,
  REMEDIATION_STATUSES,
  REQUIREMENT_ASSESSMENTS,
  REVIEW_CONFIDENCE,
  REVIEW_DECIDERS,
} from './model.ts';
import type { AiDecisionRecord, FindingAssessment, RemediationRecord, RequirementAssessment } from './model.ts';
import { decodeCallMetadata, decodeContextSummary } from './schema.ts';

/**
 * Decoders for auto-decision records (schema version 9): structured
 * remediation requirements and AI decision-maker judgments. Strict like the
 * rest of the state schema; cross-record rules live in `invariants.ts`.
 */

const NOTE_RULES = { minLength: 0, maxLength: AI_LIMITS.assessmentNote } as const;
const REASON_RULES = { maxLength: AI_LIMITS.decisionReason } as const;

export function decodeRemediation(value: unknown, path: string): RemediationRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'taskId',
    'fromAttempt',
    'reviewId',
    'source',
    'requirements',
    'createdAt',
    'status',
    'resolvedAt',
    'resolvedByReviewId',
  ]);
  const record: RemediationRecord = {
    id: r.id('id'),
    taskId: r.id('taskId'),
    fromAttempt: r.integer('fromAttempt', { min: 1 }),
    reviewId: r.id('reviewId'),
    source: r.oneOf('source', REVIEW_DECIDERS),
    requirements: r.array('requirements', (item, itemPath) => decodeText(item, itemPath, AI_LIMITS.requirementText), AI_LIMITS.remediationRequirements),
    createdAt: r.timestamp('createdAt'),
    status: r.oneOf('status', REMEDIATION_STATUSES),
    resolvedAt: r.nullableTimestamp('resolvedAt'),
    resolvedByReviewId: r.nullableId('resolvedByReviewId'),
  };
  if (record.requirements.length === 0) {
    throw new SchemaViolation(`${path}.requirements`, 'must contain at least one requirement');
  }
  const resolved = record.status === 'satisfied';
  if (resolved !== (record.resolvedAt !== null) || resolved !== (record.resolvedByReviewId !== null)) {
    throw new SchemaViolation(`${path}.status`, 'a satisfied remediation (and only one) records when and by which review');
  }
  return record;
}

export function decodeAiDecision(value: unknown, path: string): AiDecisionRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'taskId',
    'attempt',
    'reviewId',
    'status',
    'verdict',
    'confidence',
    'reason',
    'requiredActions',
    'humanReason',
    'findingAssessments',
    'requirementAssessments',
    'effect',
    'policyNote',
    'call',
    'context',
    'diagnostic',
    'createdAt',
  ]);
  const record: AiDecisionRecord = {
    id: r.id('id'),
    taskId: r.id('taskId'),
    attempt: r.integer('attempt', { min: 1 }),
    reviewId: r.id('reviewId'),
    status: r.oneOf('status', AI_DECISION_STATUSES),
    verdict: r.nullable('verdict', (item, itemPath) => oneOf(item, itemPath, AI_DECISION_VERDICTS)),
    confidence: r.nullable('confidence', (item, itemPath) => oneOf(item, itemPath, REVIEW_CONFIDENCE)),
    reason: r.nullableString('reason', REASON_RULES),
    requiredActions: r.array('requiredActions', (item, itemPath) => decodeText(item, itemPath, AI_LIMITS.requirementText), AI_LIMITS.remediationRequirements),
    humanReason: r.nullableString('humanReason', REASON_RULES),
    findingAssessments: r.array('findingAssessments', decodeFindingAssessment, AI_LIMITS.reviewFindings),
    requirementAssessments: r.array('requirementAssessments', decodeRequirementAssessment, AI_LIMITS.remediationRequirements * 10),
    effect: r.oneOf('effect', AI_DECISION_EFFECTS),
    policyNote: r.nullableString('policyNote', REASON_RULES),
    call: r.field('call', decodeCallMetadata),
    context: r.field('context', decodeContextSummary),
    diagnostic: r.nullableString('diagnostic', { maxLength: AI_LIMITS.diagnostic }),
    createdAt: r.timestamp('createdAt'),
  };
  checkDecisionShape(record, path);
  return record;
}

/**
 * A usable answer has a verdict, confidence and reason; anything else has
 * none and can only have escalated. Effects never exceed the verdict:
 * acceptance needs an accept verdict, remediation a reject verdict with
 * required actions.
 */
function checkDecisionShape(record: AiDecisionRecord, path: string): void {
  const decided = record.status === 'decided';
  if (decided !== (record.verdict !== null) || decided !== (record.confidence !== null) || decided !== (record.reason !== null)) {
    throw new SchemaViolation(`${path}.status`, 'verdict, confidence and reason are recorded exactly for a decided answer');
  }
  if (!decided && record.effect !== 'escalated') {
    throw new SchemaViolation(`${path}.effect`, 'an answer that was not obtained can only escalate');
  }
  if (record.effect === 'accepted' && record.verdict !== 'accept') {
    throw new SchemaViolation(`${path}.effect`, 'only an accept verdict can accept');
  }
  if (record.effect === 'remediation-required' && (record.verdict !== 'reject' || record.requiredActions.length === 0)) {
    throw new SchemaViolation(`${path}.effect`, 'only a reject verdict with required actions can require remediation');
  }
  if ((record.verdict === 'reject') !== (record.requiredActions.length > 0)) {
    throw new SchemaViolation(`${path}.requiredActions`, 'must be given exactly for a reject verdict');
  }
  if ((record.verdict === 'escalate') !== (record.humanReason !== null)) {
    throw new SchemaViolation(`${path}.humanReason`, 'must be given exactly for an escalate verdict');
  }
}

function decodeFindingAssessment(value: unknown, path: string): FindingAssessment {
  const r = new ObjectReader(value, path, ['finding', 'status', 'note']);
  return {
    finding: r.integer('finding', { min: 1, max: AI_LIMITS.reviewFindings }),
    status: r.oneOf('status', FINDING_ASSESSMENTS),
    note: r.string('note', NOTE_RULES),
  };
}

function decodeRequirementAssessment(value: unknown, path: string): RequirementAssessment {
  const r = new ObjectReader(value, path, ['requirement', 'status', 'evidence']);
  return {
    requirement: r.string('requirement', { maxLength: 8, pattern: /^R[1-9][0-9]{0,2}$/, patternDescription: 'a requirement label such as R1' }),
    status: r.oneOf('status', REQUIREMENT_ASSESSMENTS),
    evidence: r.string('evidence', NOTE_RULES),
  };
}

function decodeText(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength || value.includes('\0')) {
    throw new SchemaViolation(path, `must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SchemaViolation(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
