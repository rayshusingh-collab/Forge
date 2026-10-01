import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';

import { StateConflictError, StateError } from '../core/errors.ts';
import type { ForgeLayout } from '../projects/index.ts';
import { isErrorCode } from '../state/index.ts';
import { processLiveness } from '../tasks/index.ts';

/**
 * The orchestration lease: `.forge/orchestration.lock`, created exclusively
 * (`wx`) by the one `forge run` allowed to control a project at a time.
 *
 * - It is separate from the state lock. The orchestrator takes it once,
 *   without waiting, and never while holding the state lock; the task
 *   engine keeps taking the state lock per operation (and for whole
 *   edit-enabled worker runs), so the two cannot deadlock.
 * - A lease is never stolen: if the owner looks dead, Forge says so and
 *   leaves deleting the file to a human.
 * - The owner proves the lease is still its own by a random token; a
 *   deleted or replaced lease is detected before every step, and a lease
 *   that is no longer provably ours is never removed.
 */

export interface LeaseOwner {
  readonly runId: string;
  readonly pid: number;
  readonly host: string;
  readonly acquiredAt: string;
}

export interface OrchestrationLease {
  readonly path: string;
  readonly owner: LeaseOwner;
  /** True while the lock file is still exactly the one this lease wrote. */
  isIntact(): Promise<boolean>;
  /** Removes the lock file only if it is still intact. Returns whether it was removed. */
  release(): Promise<boolean>;
}

export interface LeaseStatus {
  readonly held: boolean;
  readonly owner: LeaseOwner | null;
  /** False when the owner is a process on this machine that no longer exists. */
  readonly ownerAlive: boolean | null;
}

export async function acquireOrchestrationLease(layout: ForgeLayout, runId: string, now: Date): Promise<OrchestrationLease> {
  const path = layout.orchestrationLockFile;
  const owner: LeaseOwner = { runId, pid: process.pid, host: hostname(), acquiredAt: now.toISOString() };
  const content = JSON.stringify({ ...owner, token: randomBytes(16).toString('hex') });

  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (!isErrorCode(error, 'EEXIST')) {
      throw new StateError('Cannot create the orchestration lock file', { details: { path }, cause: error });
    }
    const status = await readLeaseStatus(layout);
    const who =
      status.owner === null
        ? 'an unknown owner (the lock file is unreadable)'
        : `run ${status.owner.runId.slice(0, 8)} (pid ${status.owner.pid} on ${status.owner.host}, since ${status.owner.acquiredAt})`;
    const stale =
      status.ownerAlive === false
        ? ` That process no longer exists, so the lock is probably stale; if you are sure no \`forge run\` is active, delete ${path}.`
        : '';
    throw new StateConflictError(`Another orchestration run controls this project: ${who}.${stale} Forge never takes over a lease automatically.`, {
      details: { path },
    });
  }
  try {
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw new StateError('Cannot write the orchestration lock file', { details: { path }, cause: error });
  }
  await handle.close();

  let released = false;
  const isIntact = async (): Promise<boolean> => {
    try {
      const info = await lstat(path);
      return info.isFile() && (await readFile(path, 'utf8')) === content;
    } catch {
      return false;
    }
  };
  return {
    path,
    owner,
    isIntact,
    release: async () => {
      if (released || !(await isIntact())) {
        return false;
      }
      released = true;
      await unlink(path).catch(() => undefined);
      return true;
    },
  };
}

/** Reads who holds the lease (for status output and refusals). Never modifies it. */
export async function readLeaseStatus(layout: ForgeLayout): Promise<LeaseStatus> {
  let text: string;
  try {
    const info = await lstat(layout.orchestrationLockFile);
    if (!info.isFile() || info.size > 4096) {
      return { held: true, owner: null, ownerAlive: null };
    }
    text = await readFile(layout.orchestrationLockFile, 'utf8');
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return { held: false, owner: null, ownerAlive: null };
    }
    return { held: true, owner: null, ownerAlive: null };
  }
  const owner = parseOwner(text);
  return { held: true, owner, ownerAlive: owner === null ? null : processLiveness({ pid: owner.pid, host: owner.host }) };
}

function parseOwner(text: string): LeaseOwner | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (typeof value['runId'] === 'string' && typeof value['pid'] === 'number' && typeof value['host'] === 'string' && typeof value['acquiredAt'] === 'string') {
      return { runId: value['runId'], pid: value['pid'], host: value['host'], acquiredAt: value['acquiredAt'] };
    }
  } catch {
    // Unreadable owner: reported as unknown.
  }
  return null;
}
