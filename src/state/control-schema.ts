import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import { APPROVAL_DECISIONS, APPROVAL_LIMITS, APPROVAL_STATUSES, APPROVAL_TYPES, CONTROL_EVENT_KINDS, CONTROL_LIMITS } from './model.ts';
import type { ApprovalRecord, ApprovalResolution, ControlEvent, PauseState } from './model.ts';

/**
 * Decoders for human-control records (schema version 7): approvals, the
 * pause record, and control events. Strict: unknown fields are rejected,
 * and every status must agree with its timestamps and resolution.
 */

const HASH_PATTERN = /^[0-9a-f]{64}$/;

export function decodeApproval(value: unknown, path: string): ApprovalRecord {
  const r = new ObjectReader(value, path, [
    'id',
    'type',
    'status',
    'taskId',
    'runId',
    'reason',
    'evidence',
    'requestedAction',
    'boundTo',
    'fingerprint',
    'createdAt',
    'resolution',
    'consumedAt',
    'consumedByRunId',
    'invalidatedAt',
    'invalidationReason',
  ]);
  const approval: ApprovalRecord = {
    id: r.id('id'),
    type: r.oneOf('type', APPROVAL_TYPES),
    status: r.oneOf('status', APPROVAL_STATUSES),
    taskId: r.nullableId('taskId'),
    runId: r.nullableId('runId'),
    reason: r.string('reason', { maxLength: APPROVAL_LIMITS.reason }),
    evidence: r.array(
      'evidence',
      (item, itemPath) => {
        if (typeof item !== 'string' || item.length > APPROVAL_LIMITS.evidenceLine) {
          throw new SchemaViolation(itemPath, `must be a string of at most ${APPROVAL_LIMITS.evidenceLine} characters`);
        }
        return item;
      },
      APPROVAL_LIMITS.evidenceLines,
    ),
    requestedAction: r.string('requestedAction', { maxLength: APPROVAL_LIMITS.requestedAction }),
    boundTo: r.string('boundTo', { maxLength: APPROVAL_LIMITS.boundTo }),
    fingerprint: r.string('fingerprint', { pattern: HASH_PATTERN, patternDescription: 'a SHA-256 hex digest' }),
    createdAt: r.timestamp('createdAt'),
    resolution: r.nullable('resolution', decodeResolution),
    consumedAt: r.nullableTimestamp('consumedAt'),
    consumedByRunId: r.nullableId('consumedByRunId'),
    invalidatedAt: r.nullableTimestamp('invalidatedAt'),
    invalidationReason: r.nullableString('invalidationReason', { maxLength: APPROVAL_LIMITS.reason }),
  };
  checkApprovalStatus(approval, path);
  return approval;
}

/** Status, resolution, consumption and invalidation fields must tell one consistent story. */
function checkApprovalStatus(approval: ApprovalRecord, path: string): void {
  const resolved = approval.resolution !== null;
  const consumed = approval.consumedAt !== null;
  const invalidated = approval.invalidatedAt !== null;
  if ((approval.consumedAt === null) !== (approval.consumedByRunId === null) || (approval.invalidatedAt === null) !== (approval.invalidationReason === null)) {
    throw new SchemaViolation(path, 'has inconsistent consumption or invalidation fields');
  }
  const ok = ((): boolean => {
    switch (approval.status) {
      case 'pending':
        return !resolved && !consumed && !invalidated;
      case 'approved':
        return approval.resolution?.decision === 'approved' && !consumed && !invalidated;
      case 'rejected':
        return approval.resolution?.decision === 'rejected' && !consumed && !invalidated;
      case 'consumed':
        return approval.resolution?.decision === 'approved' && consumed && !invalidated;
      case 'invalidated':
        return approval.resolution?.decision !== 'rejected' && !consumed && invalidated;
    }
  })();
  if (!ok) {
    throw new SchemaViolation(`${path}.status`, `"${approval.status}" is inconsistent with its resolution, consumption or invalidation`);
  }
}

function decodeResolution(value: unknown, path: string): ApprovalResolution {
  const r = new ObjectReader(value, path, ['decision', 'reason', 'by', 'at']);
  return {
    decision: r.oneOf('decision', APPROVAL_DECISIONS),
    reason: r.string('reason', { maxLength: APPROVAL_LIMITS.reason }),
    by: r.oneOf('by', ['human'] as const),
    at: r.timestamp('at'),
  };
}

export function decodePause(value: unknown, path: string): PauseState {
  const r = new ObjectReader(value, path, ['reason', 'pausedAt', 'by']);
  return {
    reason: r.string('reason', { maxLength: CONTROL_LIMITS.reason }),
    pausedAt: r.timestamp('pausedAt'),
    by: r.oneOf('by', ['human'] as const),
  };
}

export function decodeControlEvent(value: unknown, path: string): ControlEvent {
  const r = new ObjectReader(value, path, ['id', 'at', 'kind', 'reason', 'detail', 'by']);
  return {
    id: r.id('id'),
    at: r.timestamp('at'),
    kind: r.oneOf('kind', CONTROL_EVENT_KINDS),
    reason: r.nullableString('reason', { maxLength: CONTROL_LIMITS.reason }),
    detail: r.nullableString('detail', { maxLength: CONTROL_LIMITS.detail }),
    by: r.oneOf('by', ['human'] as const),
  };
}
