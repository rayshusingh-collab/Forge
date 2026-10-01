import { WorkflowError } from '../core/errors.ts';
import { APPROVAL_LIMITS } from '../state/index.ts';
import type { ApprovalDecision, ApprovalRecord, ApprovalType, ProjectState } from '../state/index.ts';
import { taskApprovalBinding } from './binding.ts';

/**
 * Pure transitions for approval requests.
 *
 *   Forge requests (pending) -> a HUMAN approves or rejects -> Forge consumes
 *   an approved request at most once, only while its fingerprint still
 *   matches the evidence; otherwise it is invalidated.
 *
 * Resolution is only reachable from the `forge approval` CLI. Nothing in the
 * orchestrator, the AI roles, or worker handling calls `resolveApproval`.
 */

export interface ApprovalRequestInput {
  readonly id: string;
  readonly type: ApprovalType;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly requestedAction: string;
  readonly boundTo: string;
  readonly fingerprint: string;
}

export interface ApprovalRequestResult {
  readonly state: ProjectState;
  /** The request that applies: an existing one with the same fingerprint, or the new one. */
  readonly approval: ApprovalRecord;
  readonly created: boolean;
}

const OPEN: readonly string[] = ['pending', 'approved'];

/**
 * Records a request, unless one for the same subject and fingerprint already
 * exists (pending, approved or rejected), in which case that one applies.
 * An open request for the same subject with a different fingerprint is
 * invalidated: it was about evidence that no longer exists.
 */
export function requestApproval(state: ProjectState, input: ApprovalRequestInput, now: Date): ApprovalRequestResult {
  const sameSubject = (approval: ApprovalRecord): boolean =>
    approval.type === input.type && approval.taskId === input.taskId && (input.taskId !== null || approval.runId === input.runId);
  const existing = [...state.approvals]
    .reverse()
    .find((approval) => sameSubject(approval) && approval.fingerprint === input.fingerprint && ['pending', 'approved', 'rejected'].includes(approval.status));
  if (existing !== undefined) {
    return { state, approval: existing, created: false };
  }
  let approvals = state.approvals.map((approval) =>
    sameSubject(approval) && OPEN.includes(approval.status) ? invalidated(approval, 'superseded: the evidence it was bound to changed', now) : approval,
  );
  const approval: ApprovalRecord = {
    id: input.id,
    type: input.type,
    status: 'pending',
    taskId: input.taskId,
    runId: input.runId,
    reason: bound(input.reason, APPROVAL_LIMITS.reason),
    evidence: input.evidence.slice(0, APPROVAL_LIMITS.evidenceLines).map((line) => bound(line, APPROVAL_LIMITS.evidenceLine)),
    requestedAction: bound(input.requestedAction, APPROVAL_LIMITS.requestedAction),
    boundTo: bound(input.boundTo, APPROVAL_LIMITS.boundTo),
    fingerprint: input.fingerprint,
    createdAt: now.toISOString(),
    resolution: null,
    consumedAt: null,
    consumedByRunId: null,
    invalidatedAt: null,
    invalidationReason: null,
  };
  approvals = prune([...approvals, approval]);
  return { state: { ...state, approvals }, approval, created: true };
}

export type ResolveOutcome = { readonly kind: 'resolved'; readonly state: ProjectState } | { readonly kind: 'stale'; readonly state: ProjectState };

/**
 * A HUMAN decision on a pending request. `currentFingerprint` is the
 * fingerprint of the evidence as it is now (null when it cannot be computed
 * from state, e.g. lease recovery, which is re-checked when used). If the
 * evidence changed since the request, the request is invalidated instead.
 */
export function resolveApproval(
  state: ProjectState,
  approvalId: string,
  decision: ApprovalDecision,
  reason: string,
  now: Date,
  currentFingerprint: string | null,
): ResolveOutcome {
  const approval = findApproval(state, approvalId);
  if (approval.status !== 'pending') {
    throw new WorkflowError(`Approval ${approval.id.slice(0, 8)} is ${approval.status}; only a pending approval can be ${decision}`);
  }
  const text = reason.trim();
  if (text === '' || text.length > APPROVAL_LIMITS.reason || text.includes('\0')) {
    throw new WorkflowError(`A reason of 1-${APPROVAL_LIMITS.reason} characters is required`);
  }
  if (currentFingerprint !== null && currentFingerprint !== approval.fingerprint) {
    return { kind: 'stale', state: replace(state, invalidated(approval, 'the evidence changed before a decision was recorded', now)) };
  }
  const resolved: ApprovalRecord = { ...approval, status: decision, resolution: { decision, reason: text, by: 'human', at: now.toISOString() } };
  return { kind: 'resolved', state: replace(state, resolved) };
}

/**
 * Uses an approved request exactly once. Refused (and the request
 * invalidated) when the evidence no longer matches its fingerprint.
 */
export function consumeApproval(state: ProjectState, approvalId: string, runId: string, currentFingerprint: string | null, now: Date): ResolveOutcome {
  const approval = findApproval(state, approvalId);
  if (approval.status !== 'approved') {
    throw new WorkflowError(`Approval ${approval.id.slice(0, 8)} is ${approval.status}; only an approved, unused approval can be used`);
  }
  if (currentFingerprint !== approval.fingerprint) {
    return { kind: 'stale', state: replace(state, invalidated(approval, 'the evidence changed after approval; it no longer applies', now)) };
  }
  return { kind: 'resolved', state: replace(state, { ...approval, status: 'consumed', consumedAt: now.toISOString(), consumedByRunId: runId }) };
}

/** Current fingerprint of a task-scoped approval's evidence (null for lease recovery or a missing task). */
export function currentFingerprint(state: ProjectState, approval: ApprovalRecord): string | null {
  if (approval.type === 'lease-recovery' || approval.taskId === null) {
    return null;
  }
  return taskApprovalBinding(state, approval.type, approval.taskId)?.fingerprint ?? null;
}

/** Open task-scoped approvals whose evidence changed (what `sweepApprovals` would invalidate). */
export function staleApprovals(state: ProjectState): ApprovalRecord[] {
  return state.approvals.filter(
    (approval) => OPEN.includes(approval.status) && approval.type !== 'lease-recovery' && currentFingerprint(state, approval) !== approval.fingerprint,
  );
}

/** Invalidates every open task-scoped approval whose evidence changed. Returns the same state if none did. */
export function sweepApprovals(state: ProjectState, now: Date): ProjectState {
  const stale = new Set(staleApprovals(state).map((approval) => approval.id));
  if (stale.size === 0) {
    return state;
  }
  return {
    ...state,
    approvals: state.approvals.map((approval) => (stale.has(approval.id) ? invalidated(approval, 'the evidence it was bound to changed', now) : approval)),
  };
}

/** Full ID, or a unique prefix of at least 4 characters. */
export function resolveApprovalReference(state: ProjectState, reference: string): string {
  const text = reference.trim().toLowerCase();
  const exact = state.approvals.find((approval) => approval.id === text);
  if (exact !== undefined) {
    return exact.id;
  }
  if (text.length < 4) {
    throw new WorkflowError(`Approval reference "${reference}" is too short; use at least 4 characters of its ID`);
  }
  const matches = state.approvals.filter((approval) => approval.id.startsWith(text));
  if (matches.length === 0) {
    throw new WorkflowError(`No approval matches "${reference}"; list them with \`forge approval list\``);
  }
  if (matches.length > 1) {
    throw new WorkflowError(`"${reference}" matches ${matches.length} approvals; use more characters`);
  }
  return matches[0]!.id;
}

function findApproval(state: ProjectState, approvalId: string): ApprovalRecord {
  const approval = state.approvals.find((candidate) => candidate.id === approvalId);
  if (approval === undefined) {
    throw new WorkflowError(`Unknown approval "${approvalId}"`);
  }
  return approval;
}

function invalidated(approval: ApprovalRecord, reason: string, now: Date): ApprovalRecord {
  return { ...approval, status: 'invalidated', invalidatedAt: now.toISOString(), invalidationReason: reason };
}

function replace(state: ProjectState, approval: ApprovalRecord): ProjectState {
  return { ...state, approvals: state.approvals.map((candidate) => (candidate.id === approval.id ? approval : candidate)) };
}

/** Keeps the newest records within the bound, dropping the oldest finished ones first. */
function prune(approvals: ApprovalRecord[]): ApprovalRecord[] {
  let excess = approvals.length - APPROVAL_LIMITS.retained;
  if (excess <= 0) {
    return approvals;
  }
  return approvals.filter((approval) => {
    if (excess > 0 && !OPEN.includes(approval.status)) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

function bound(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
