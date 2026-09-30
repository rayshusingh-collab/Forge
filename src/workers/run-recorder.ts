import { tmpdir } from 'node:os';

import { IntegrityError } from '../core/errors.ts';
import {
  describeIntegrityChanges,
  openStateStore,
  snapshotControlState,
  verifyControlState,
  writeIntegrityEvidence,
} from '../projects/index.ts';
import type { ControlSnapshot, IntegrityReport, LoadedProject } from '../projects/index.ts';
import { WORKER_RUN_LIMITS } from '../state/index.ts';
import type { ProjectState, StateStore, WorkerRunRecord, WorkerRunStatus, WorkerRunTrigger } from '../state/index.ts';
import { excerpt, truncate } from './text.ts';
import type { Worker, WorkerRequest, WorkerResult } from './types.ts';

export interface RecordedRunOptions {
  readonly worker: Worker;
  readonly request: WorkerRequest;
  readonly project: LoadedProject;
  /** Defaults to the project's own state store. */
  readonly store?: StateStore;
  readonly trigger: WorkerRunTrigger;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
  /** Where integrity evidence reports are written; never inside the project. Defaults to the OS temp directory. */
  readonly evidenceDirectory?: string;
}

export interface RecordedRun {
  /** What the worker itself reported. */
  readonly result: WorkerResult;
  /**
   * Forge's final verdict: the worker outcome, or `integrity-violation` when
   * `.forge/` changed during the run. Only `success` means success.
   */
  readonly status: WorkerRunStatus;
  readonly integrity: IntegrityReport;
  /** Path of the evidence report, when a violation was detected and recorded. */
  readonly evidencePath: string | undefined;
  /** The final persisted record, or undefined if the outcome was not persisted. */
  readonly record: WorkerRunRecord | undefined;
  /** Why the outcome was not persisted, if it was not. */
  readonly persistenceError: Error | undefined;
}

type Persist = (change: (state: ProjectState) => ProjectState) => Promise<ProjectState>;

/**
 * Runs a worker with bounded bookkeeping in project state, guarding Forge's
 * control state (`.forge/`) against modification by the worker.
 *
 * Edit-enabled runs hold the state lease for the entire run:
 *   lease → record `running` → snapshot `.forge/` (full) → run worker →
 *   verify snapshot → record outcome → release lease.
 * With the lease held, no Forge process can write state during the run
 * (others fail with a conflict rather than write), so every byte under
 * `.forge/` must be unchanged afterwards; any change is not Forge's.
 *
 * Read-only runs cannot modify files, so they use normal conflict-retrying
 * updates and a cheap check of the immutable metadata only.
 *
 * On a violation, nothing is repaired or reset. The run is recorded as
 * `integrity-violation` only if `state.json`, the lock, and `.forge/` itself
 * are provably untouched; otherwise Forge fails closed and writes nothing.
 */
export async function runRecordedWorker(options: RecordedRunOptions): Promise<RecordedRun> {
  const store = options.store ?? openStateStore(options.project);
  const clock = options.clock ?? (() => new Date());
  const running = runningRecord(options, clock);

  if (options.request.access !== 'edit') {
    await store.update((state) => withRun(state, running));
    const snapshot = await snapshotControlState(options.project.layout, 'metadata');
    const result = await execute(options);
    return finish(options, clock, running, result, snapshot, (change) => store.update(change));
  }

  // Throws StateConflictError if another Forge process holds the lock: the worker is not started.
  const lease = await store.acquireLease();
  try {
    await lease.update((state) => withRun(state, running));
    const snapshot = await snapshotControlState(options.project.layout, 'full');
    const result = await execute(options);
    return await finish(options, clock, running, result, snapshot, (change) => lease.update(change));
  } finally {
    // Removes the lock only if it is still ours; a replaced lock is left as evidence.
    await lease.release();
  }
}

async function finish(
  options: RecordedRunOptions,
  clock: () => Date,
  running: WorkerRunRecord,
  result: WorkerResult,
  snapshot: ControlSnapshot,
  persist: Persist,
): Promise<RecordedRun> {
  const integrity = await verifyControlState(options.project, snapshot);
  const finished: WorkerRunRecord = {
    ...running,
    status: result.outcome,
    finishedAt: clock().toISOString(),
    durationMs: result.durationMs,
    summary: result.summary === null ? null : truncate(result.summary.trim(), WORKER_RUN_LIMITS.summary),
    diagnostic: result.diagnostics[0] === undefined ? null : excerpt(result.diagnostics[0], WORKER_RUN_LIMITS.diagnostic),
  };

  if (integrity.ok) {
    return save(result, result.outcome, integrity, undefined, finished, persist);
  }

  let evidencePath: string | undefined;
  let evidenceProblem = '';
  try {
    evidencePath = await writeIntegrityEvidence({
      directory: options.evidenceDirectory ?? tmpdir(),
      runId: options.request.id,
      project: options.project,
      snapshot,
      report: integrity,
    });
  } catch (error) {
    evidenceProblem = ` (evidence report could not be written: ${error instanceof Error ? error.message : String(error)})`;
  }

  const summaryOfChanges = describeIntegrityChanges(integrity);
  const violation: WorkerRunRecord = {
    ...finished,
    status: 'integrity-violation',
    diagnostic: excerpt(
      `Forge control state changed during the run: ${summaryOfChanges}. Evidence: ${evidencePath ?? 'unavailable'}${evidenceProblem}`,
      WORKER_RUN_LIMITS.diagnostic,
    ),
  };

  const stateUntouched = !integrity.stateFileChanged && !integrity.lockFileChanged && !integrity.controlDirectoryReplaced;
  if (!stateUntouched) {
    // Writing now would overwrite the evidence and trust state that can no longer be trusted.
    const error = new IntegrityError(
      `Forge did not record this run: its control state was modified during the run (${summaryOfChanges}). ` +
        'Nothing was restored or reset; inspect .forge/ and the evidence report.',
      { details: { runId: options.request.id, evidencePath } },
    );
    return { result, status: 'integrity-violation', integrity, evidencePath, record: undefined, persistenceError: error };
  }
  return save(result, 'integrity-violation', integrity, evidencePath, violation, persist);
}

async function save(
  result: WorkerResult,
  status: WorkerRunStatus,
  integrity: IntegrityReport,
  evidencePath: string | undefined,
  record: WorkerRunRecord,
  persist: Persist,
): Promise<RecordedRun> {
  try {
    await persist((state) => withRun(state, record));
    return { result, status, integrity, evidencePath, record, persistenceError: undefined };
  } catch (error) {
    const persistenceError = error instanceof Error ? error : new Error(String(error));
    return { result, status, integrity, evidencePath, record: undefined, persistenceError };
  }
}

function execute(options: RecordedRunOptions): Promise<WorkerResult> {
  return options.worker.execute(options.request, options.signal === undefined ? {} : { signal: options.signal });
}

function runningRecord(options: RecordedRunOptions, clock: () => Date): WorkerRunRecord {
  return {
    id: options.request.id,
    worker: options.worker.id,
    trigger: options.trigger,
    access: options.request.access,
    task: excerpt(options.request.task, WORKER_RUN_LIMITS.taskExcerpt),
    workingDirectory: options.request.relativeWorkingDirectory,
    status: 'running',
    startedAt: clock().toISOString(),
    finishedAt: null,
    durationMs: null,
    summary: null,
    diagnostic: null,
  };
}

/** Inserts or replaces the run by ID, keeping only the most recent runs. */
function withRun(state: ProjectState, run: WorkerRunRecord): ProjectState {
  const others = state.workerRuns.filter((existing) => existing.id !== run.id);
  const runs = [...others, run].slice(-WORKER_RUN_LIMITS.retainedRuns);
  return { ...state, workerRuns: runs };
}
