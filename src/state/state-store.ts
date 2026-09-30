import { StateConflictError, StateError } from '../core/errors.ts';
import { SchemaViolation } from '../core/validation.ts';
import { acquireFileLock, readJsonDocument, serializeJson, withFileLock, writeFileAtomic } from './files.ts';
import { STATE_SCHEMA_VERSION } from './model.ts';
import type { ProjectState } from './model.ts';
import { STATE_MIGRATIONS, decodeProjectState } from './schema.ts';
import { UnsupportedVersionError, upgradeDocument } from './versioning.ts';

export interface StateStoreOptions {
  /** Absolute path of the state document, e.g. `<root>/.forge/state.json`. */
  readonly stateFile: string;
  /** Absolute path of the lock file guarding writes. */
  readonly lockFile: string;
  /** State belonging to any other project is rejected. */
  readonly projectId: string;
  readonly clock?: () => Date;
  /** How long a write waits for another writer's lock. */
  readonly lockTimeoutMs?: number;
}

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** Exclusive write access to project state, held until released. */
export interface StateLease {
  readonly lockFile: string;
  /** Read-modify-write under the held lock; fails if the lock is no longer intact. */
  update(change: (state: ProjectState) => ProjectState): Promise<ProjectState>;
  /** True while the lock file on disk is still this lease's own. */
  isIntact(): Promise<boolean>;
  /** Releases the lock if it is still intact; returns whether it was removed. */
  release(): Promise<boolean>;
}

/**
 * Loads and saves one project's state document.
 *
 * Concurrency: every document carries a `revision`. `save` only succeeds if
 * the on-disk revision still equals the revision the caller loaded, then
 * writes revision + 1. The compare-and-write runs under an exclusive lock
 * file, so two local processes cannot both win. A loser gets a
 * `StateConflictError` and must reload; updates are never silently lost.
 *
 * Integrity: everything read from disk is validated; malformed or
 * unsupported state raises a `StateError` and is never repaired silently.
 * Everything written is validated first, so Forge cannot persist state it
 * would itself reject.
 */
export class StateStore {
  private readonly options: StateStoreOptions;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;

  constructor(options: StateStoreOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  /** Writes the first state document. Fails if one already exists. */
  async create(initial: ProjectState): Promise<ProjectState> {
    const state = this.validateForWrite(initial);
    return this.locked(async () => {
      if ((await readJsonDocument(this.options.stateFile, 'Project state')) !== undefined) {
        throw new StateConflictError('Project state already exists', { details: { path: this.options.stateFile } });
      }
      await writeFileAtomic(this.options.stateFile, serializeJson(state));
      return state;
    });
  }

  async load(): Promise<ProjectState> {
    const raw = await readJsonDocument(this.options.stateFile, 'Project state');
    if (raw === undefined) {
      throw new StateError('Project state file is missing', { details: { path: this.options.stateFile } });
    }
    return this.decode(raw, 'Project state is invalid');
  }

  /**
   * Persists `next`, whose `revision` must equal the revision currently on
   * disk (i.e. the revision the caller loaded). Returns the stored state with
   * the incremented revision and a fresh `updatedAt`.
   */
  async save(next: ProjectState): Promise<ProjectState> {
    this.validateForWrite(next);
    return this.locked(() => this.saveWhileLocked(next));
  }

  /**
   * Takes the state lock and keeps it until `release()`, so no other Forge
   * process can write state in between. Used to fence off a period in which
   * state must not change except through this lease (e.g. an edit-enabled
   * worker run). Other writers wait, then fail with `StateConflictError`.
   */
  async acquireLease(): Promise<StateLease> {
    const lock = await acquireFileLock(this.options.lockFile, { timeoutMs: this.lockTimeoutMs });
    return {
      lockFile: lock.path,
      isIntact: () => lock.isIntact(),
      release: () => lock.release(),
      update: async (change) => {
        // Never write through a lock that is no longer provably ours.
        if (!(await lock.isIntact())) {
          throw new StateConflictError('State lock was removed or replaced while held; refusing to write', {
            details: { path: lock.path },
          });
        }
        const current = await this.load();
        return this.saveWhileLocked(this.validateForWrite({ ...change(current), revision: current.revision }));
      },
    };
  }

  private async saveWhileLocked(next: ProjectState): Promise<ProjectState> {
    const current = await this.load();
    if (current.revision !== next.revision) {
      throw new StateConflictError(
        `Project state was modified by another process (expected revision ${next.revision}, found ${current.revision}); reload and retry`,
        { details: { path: this.options.stateFile, expected: next.revision, found: current.revision } },
      );
    }
    const stored = this.validateForWrite({
      ...next,
      revision: current.revision + 1,
      updatedAt: this.clock().toISOString(),
    });
    await writeFileAtomic(this.options.stateFile, serializeJson(stored));
    return stored;
  }

  /**
   * Read-modify-write: loads the latest state, applies `change`, and saves.
   * On a conflict the change is re-applied to freshly loaded state, at most
   * `maxAttempts` times in total, so `change` must be a pure function of the
   * state it receives. Other errors (e.g. invalid state) are not retried.
   */
  async update(change: (state: ProjectState) => ProjectState, maxAttempts = 3): Promise<ProjectState> {
    for (let attempt = 1; ; attempt++) {
      const current = await this.load();
      try {
        return await this.save({ ...change(current), revision: current.revision });
      } catch (error) {
        if (!(error instanceof StateConflictError) || attempt >= maxAttempts) {
          throw error;
        }
      }
    }
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    return withFileLock(this.options.lockFile, { timeoutMs: this.lockTimeoutMs }, action);
  }

  private validateForWrite(state: ProjectState): ProjectState {
    // Round-trip through JSON so exactly what will be written is validated.
    return this.decode(JSON.parse(JSON.stringify(state)) as unknown, 'Refusing to write invalid project state');
  }

  private decode(raw: unknown, problem: string): ProjectState {
    let state: ProjectState;
    try {
      state = decodeProjectState(upgradeDocument(raw, STATE_SCHEMA_VERSION, STATE_MIGRATIONS));
    } catch (error) {
      if (error instanceof SchemaViolation || error instanceof UnsupportedVersionError) {
        throw new StateError(`${problem}: ${error.message}`, {
          details: { path: this.options.stateFile },
          cause: error,
        });
      }
      throw error;
    }
    if (state.projectId !== this.options.projectId) {
      throw new StateError(`${problem}: state belongs to a different project (${state.projectId})`, {
        details: { path: this.options.stateFile, expectedProjectId: this.options.projectId },
      });
    }
    return state;
  }
}
