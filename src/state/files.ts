import { randomBytes } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { StateConflictError, StateError } from '../core/errors.ts';

/**
 * Low-level file primitives for Forge metadata: bounded reads, atomic writes,
 * and a simple exclusive lock. They know nothing about document schemas.
 */

/** Upper bound for any metadata document; state must not become a log store. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * Reads and parses a JSON document. Refuses symbolic links and oversized
 * files. Returns `undefined` when the file does not exist.
 */
export async function readJsonDocument(filePath: string, label: string): Promise<unknown> {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw new StateError(`Cannot read ${label}`, { details: { path: filePath }, cause: error });
  }
  if (!info.isFile()) {
    throw new StateError(`${label} is not a regular file (links are not followed)`, { details: { path: filePath } });
  }
  if (info.size > MAX_DOCUMENT_BYTES) {
    throw new StateError(`${label} exceeds the ${MAX_DOCUMENT_BYTES}-byte limit`, {
      details: { path: filePath, size: info.size },
    });
  }

  let text: string;
  const handle = await open(filePath, 'r');
  try {
    text = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new StateError(`${label} is not valid JSON`, { details: { path: filePath }, cause: error });
  }
}

/** Serializes consistently: two-space indent and a trailing newline. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Replaces `target` so readers see either the old or the new content, never a
 * partial write: data goes to a temp file in the same directory, is flushed to
 * disk, then renamed over the target.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameWithRetry(temp, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * On Windows, rename can fail transiently with EPERM/EBUSY/EACCES while
 * another process (antivirus, indexer, a concurrent reader) has the target
 * open. Retry briefly before giving up.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const attempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const transient = isErrorCode(error, 'EPERM') || isErrorCode(error, 'EBUSY') || isErrorCode(error, 'EACCES');
      if (!transient || attempt >= attempts) {
        throw error;
      }
      await delay(20 * attempt);
    }
  }
}

export interface LockOptions {
  /** How long to wait for a held lock before failing. */
  readonly timeoutMs: number;
  readonly retryIntervalMs?: number;
}

/**
 * Runs `action` while holding an exclusive lock file. The lock is created with
 * `wx` (fails if it exists), so only one local process can hold it.
 *
 * Stale locks (left by a crashed process) are never removed automatically:
 * that decision is left to the user, and the error says how.
 */
export async function withFileLock<T>(lockPath: string, options: LockOptions, action: () => Promise<T>): Promise<T> {
  const lock = await acquireFileLock(lockPath, options);
  try {
    return await action();
  } finally {
    await lock.release();
  }
}

/** An exclusive lock file held by this process until released. */
export interface HeldFileLock {
  readonly path: string;
  /**
   * True if the lock file on disk is still exactly the one this process
   * wrote (same random token), i.e. nobody deleted or replaced it.
   */
  isIntact(): Promise<boolean>;
  /**
   * Removes the lock file, but only while it is intact: a lock that was
   * deleted or replaced may now belong to someone else and is left alone.
   * Returns whether the lock was removed.
   */
  release(): Promise<boolean>;
}

export async function acquireFileLock(lockPath: string, options: LockOptions): Promise<HeldFileLock> {
  const content = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token: randomBytes(16).toString('hex'),
  });
  const handle = await acquireLock(lockPath, options, content);
  let released = false;

  const isIntact = async (): Promise<boolean> => {
    try {
      const info = await lstat(lockPath);
      return info.isFile() && (await readFile(lockPath, 'utf8')) === content;
    } catch {
      return false;
    }
  };

  return {
    path: lockPath,
    isIntact,
    release: async () => {
      if (released) {
        return false;
      }
      released = true;
      await handle.close().catch(() => undefined);
      if (!(await isIntact())) {
        return false;
      }
      await unlink(lockPath).catch(() => undefined);
      return true;
    },
  };
}

async function acquireLock(lockPath: string, options: LockOptions, content: string): Promise<FileHandle> {
  const retryIntervalMs = options.retryIntervalMs ?? 25;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw new StateError('Cannot create state lock file', { details: { path: lockPath }, cause: error });
      }
      if (Date.now() >= deadline) {
        throw new StateConflictError(
          `Project state is locked by another Forge process (${lockPath}). ` +
            'If no other Forge process is running, the lock is stale and may be deleted manually.',
          { details: { path: lockPath } },
        );
      }
      await delay(retryIntervalMs);
      continue;
    }
    try {
      // pid/time are diagnostic; the token lets the owner prove the lock is still its own.
      await handle.writeFile(content, 'utf8');
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      throw new StateError('Cannot write state lock file', { details: { path: lockPath }, cause: error });
    }
  }
}

export function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
