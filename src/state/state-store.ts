import { StateConflictError, StateError } from '../core/errors.ts';
import { SchemaViolation } from '../core/validation.ts';
import { readJsonDocument, serializeJson, withFileLock, writeFileAtomic } from './files.ts';
import type { ProjectState } from './model.ts';
import { decodeProjectState } from './schema.ts';
import { UnsupportedVersionError, upgradeDocument } from './versioning.ts';
import { STATE_SCHEMA_VERSION } from './model.ts';

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
    return this.locked(async () => {
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
    });
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
      state = decodeProjectState(upgradeDocument(raw, STATE_SCHEMA_VERSION));
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
