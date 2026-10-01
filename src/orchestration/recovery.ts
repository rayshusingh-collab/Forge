import { randomUUID } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

import { consumeApproval, leaseApprovalBinding, requestApproval } from '../approvals/index.ts';
import { appendControlEvent, requireReason } from '../control/pause.ts';
import { WorkflowError } from '../core/errors.ts';
import type { LoadedProject } from '../projects/index.ts';
import { isErrorCode } from '../state/index.ts';
import type { OrchestrationRun, ProjectState, StateStore } from '../state/index.ts';
import { processLiveness } from '../tasks/index.ts';
import type { ExecutorLiveness } from '../tasks/index.ts';
import type { LeaseOwner } from './lease.ts';

/**
 * `forge run recover`: explicit HUMAN recovery after a crashed `forge run`
 * (or crashed edit-enabled task). Never automatic, never a silent takeover.
 *
 * A crash can leave two locks: `.forge/orchestration.lock` (the run's lease)
 * and, if it died during an edit-enabled task, `.forge/state.lock` (held for
 * the whole worker run). Both record the owner's pid and host.
 *
 * - Normal recovery only when Forge can PROVE every owner is gone: each lock
 *   names a process on this machine that no longer exists, and the lease
 *   names a run this project's state knows.
 * - A lock whose owner is alive on this machine is always refused (stop that
 *   process with Ctrl+C instead), even with `--force`.
 * - Anything Forge cannot prove (another host, unreadable owner, unknown run)
 *   needs `--force` AND an approved, single-use `lease-recovery` approval
 *   bound to the exact bytes of both locks (including the owners' tokens).
 * - Each lock is re-read right before removal and must be byte-identical.
 *
 * Recovery removes the locks, marks the dead run `interrupted`, and records
 * a control event. It never touches tasks: an interrupted task still needs
 * its own recovery (an approval, or `forge task recover`).
 */

export type LeaseRecoveryResult =
  | { readonly kind: 'no-lease' }
  | {
      readonly kind: 'recovered';
      readonly owner: LeaseOwner | null;
      readonly runMarkedInterrupted: boolean;
      readonly forced: boolean;
      readonly stateLockRemoved: boolean;
    }
  | { readonly kind: 'approval-required'; readonly approvalId: string; readonly created: boolean; readonly why: string };

export interface LeaseRecoveryOptions {
  readonly project: LoadedProject;
  readonly store: StateStore;
  readonly reason: string;
  readonly force: boolean;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly liveness?: ExecutorLiveness;
}

const MAX_LOCK_BYTES = 4096;

interface LockOwner {
  readonly pid: number;
  readonly host: string | null;
}

export async function recoverOrchestrationLease(options: LeaseRecoveryOptions): Promise<LeaseRecoveryResult> {
  const clock = options.clock ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;
  const liveness = options.liveness ?? processLiveness;
  const reason = requireReason(options.reason);
  const { layout } = options.project;
  const here = hostname();
  const alive = (owner: LockOwner | null): boolean => owner !== null && owner.host === here && liveness({ pid: owner.pid, host: owner.host });
  const provablyDead = (owner: LockOwner | null): boolean => owner !== null && owner.host === here && !alive(owner);

  const lease = await readLock(layout.orchestrationLockFile);
  const stateLock = await readLock(layout.lockFile);
  if (lease === undefined && stateLock === undefined) {
    return { kind: 'no-lease' };
  }
  const owner = lease === undefined ? null : parseLeaseOwner(lease);
  const stateOwner = stateLock === undefined ? null : parseLockOwner(stateLock);
  if (alive(owner)) {
    throw new WorkflowError(
      `The orchestration lease belongs to process ${owner!.pid} on this machine, which is still running; it is not stale. Stop that run (Ctrl+C in its terminal) instead.`,
    );
  }
  if (alive(stateOwner)) {
    throw new WorkflowError(`The state lock belongs to process ${stateOwner!.pid} on this machine, which is still running (a Forge command is writing state); wait for it to finish.`);
  }

  const state = await options.store.load();
  const run = owner === null ? undefined : state.orchestrationRuns.find((candidate) => candidate.id === owner.runId);
  const leaseProven = lease === undefined || (provablyDead(owner) && run !== undefined);
  const stateLockProven = stateLock === undefined || provablyDead(stateOwner);
  const description = [
    lease === undefined
      ? null
      : owner === null
        ? 'orchestration.lock with an unreadable owner'
        : `orchestration.lock of run ${owner.runId.slice(0, 8)} (pid ${owner.pid} on ${owner.host}, since ${owner.acquiredAt})`,
    stateLock === undefined ? null : `state.lock of pid ${stateOwner?.pid ?? '?'} on ${stateOwner?.host ?? 'an unknown host'}`,
  ]
    .filter((part) => part !== null)
    .join(' and ');

  let approvalId: string | null = null;
  const binding = leaseApprovalBinding(`${lease ?? ''}\n--state.lock--\n${stateLock ?? ''}`, description);
  if (!leaseProven || !stateLockProven) {
    const why = !leaseProven
      ? owner === null
        ? 'the orchestration lock does not name a readable owner'
        : owner.host !== here
          ? `the owner ran on another machine (${owner.host}), where Forge cannot check it`
          : `the lock names run ${owner.runId.slice(0, 8)}, which this project's state does not know`
      : stateOwner?.host === null || stateOwner === null
        ? 'the state lock does not record its host (written by an older Forge), so its owner cannot be checked'
        : `the state lock's owner ran on another machine (${stateOwner.host})`;
    if (!options.force) {
      throw new WorkflowError(
        `Forge cannot prove the lock owner is gone: ${why}. If you are certain no Forge process is active, request a forced recovery with \`forge run recover --force --reason "..."\` (it needs a human approval).`,
      );
    }
    const approval = state.approvals.find(
      (candidate) => candidate.type === 'lease-recovery' && candidate.fingerprint === binding.fingerprint && ['pending', 'approved', 'rejected'].includes(candidate.status),
    );
    if (approval?.status === 'rejected') {
      throw new WorkflowError(`Forced lock recovery was rejected by a human (approval ${approval.id.slice(0, 8)}: ${approval.resolution?.reason ?? ''})`);
    }
    if (approval?.status !== 'approved') {
      if (stateLock !== undefined) {
        // Requesting the approval is itself a state write; it needs the state lock to be free.
        throw new WorkflowError(
          `The state lock is held and its owner cannot be proven gone (${why}). Remove .forge/state.lock by hand only after making sure no Forge process is running, then retry.`,
        );
      }
      let id = approval?.id ?? '';
      let created = false;
      if (approval === undefined) {
        await options.store.update((current) => {
          const result = requestApproval(
            current,
            {
              id: generateId(),
              type: 'lease-recovery',
              taskId: null,
              runId: owner?.runId ?? null,
              reason: `Forced recovery of the orchestration lock requested: ${reason}`,
              evidence: [description, `why Forge cannot prove the owner is gone: ${why}`, `lock fingerprint: ${binding.fingerprint.slice(0, 16)}`],
              requestedAction: 'Remove exactly these lock files (only if unchanged) and mark the run interrupted; no task is re-run.',
              boundTo: binding.boundTo,
              fingerprint: binding.fingerprint,
            },
            clock(),
          );
          id = result.approval.id;
          created = result.created;
          return result.state;
        });
      }
      return { kind: 'approval-required', approvalId: id, created, why };
    }
    approvalId = approval.id;
  }

  // The state lock must go first (recording needs it); each lock must still be exactly what was inspected.
  let stateLockRemoved = false;
  if (stateLock !== undefined) {
    await removeIfUnchanged(layout.lockFile, stateLock, 'state lock');
    stateLockRemoved = true;
  }
  if (lease !== undefined && (await readLock(layout.orchestrationLockFile)) !== lease) {
    throw new WorkflowError('The orchestration lock changed while it was being recovered (owner token mismatch); it was left in place');
  }
  const now = clock();
  let runMarkedInterrupted = false;
  await options.store.update((current) => {
    let next: ProjectState = current;
    if (approvalId !== null) {
      const consumed = consumeApproval(next, approvalId, owner?.runId ?? 'lease-recovery', binding.fingerprint, now);
      if (consumed.kind === 'stale') {
        throw new WorkflowError('The lease-recovery approval no longer matches the locks; nothing more was removed');
      }
      next = consumed.state;
    }
    runMarkedInterrupted = false;
    next = {
      ...next,
      orchestrationRuns: next.orchestrationRuns.map((candidate): OrchestrationRun => {
        if (owner !== null && candidate.id === owner.runId && candidate.status === 'running') {
          runMarkedInterrupted = true;
          return { ...candidate, status: 'interrupted', finishedAt: now.toISOString() };
        }
        return candidate;
      }),
    };
    return appendControlEvent(
      next,
      { id: generateId(), kind: 'lease-recovered', reason, detail: `${approvalId === null ? 'owners proven dead' : `forced with approval ${approvalId.slice(0, 8)}`}: ${description}` },
      now,
    );
  });
  if (lease !== undefined) {
    await removeIfUnchanged(layout.orchestrationLockFile, lease, 'orchestration lock');
  }
  return { kind: 'recovered', owner, runMarkedInterrupted, forced: approvalId !== null, stateLockRemoved };
}

async function removeIfUnchanged(path: string, expected: string, label: string): Promise<void> {
  if ((await readLock(path)) !== expected) {
    throw new WorkflowError(`The ${label} changed during recovery (owner token mismatch); it was left in place`);
  }
  await unlink(path);
}

/** The lock's exact text; undefined when absent. Anything but a small regular file is refused. */
async function readLock(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile() || info.size > MAX_LOCK_BYTES) {
    throw new WorkflowError(`${path} is not a small regular file (links are never followed); inspect and remove it by hand`);
  }
  return readFile(path, 'utf8');
}

function parseLeaseOwner(text: string): LeaseOwner | null {
  const value = parseJson(text);
  if (value !== null && typeof value['runId'] === 'string' && typeof value['pid'] === 'number' && typeof value['host'] === 'string' && typeof value['acquiredAt'] === 'string') {
    return { runId: value['runId'], pid: value['pid'], host: value['host'], acquiredAt: value['acquiredAt'] };
  }
  return null;
}

function parseLockOwner(text: string): LockOwner | null {
  const value = parseJson(text);
  if (value !== null && typeof value['pid'] === 'number') {
    return { pid: value['pid'], host: typeof value['host'] === 'string' ? value['host'] : null };
  }
  return null;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
