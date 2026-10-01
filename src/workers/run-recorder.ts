import { tmpdir } from 'node:os';

import { assertNotPaused } from '../control/pause.ts';
import { IntegrityError } from '../core/errors.ts';
import { redactSecrets, secretValues } from '../core/redaction.ts';
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

export interface RecordedRunOptions<P = undefined> {
  readonly worker: Worker;
  readonly request: WorkerRequest;
  readonly project: LoadedProject;
  /** Defaults to the project's own state store. */
  readonly store?: StateStore;
  readonly trigger: WorkerRunTrigger;
  /** Required for `task` runs: the task and attempt this run executes. */
  readonly link?: { readonly taskId: string; readonly attempt: number };
  /** Task-engine transitions applied atomically with the run records. */
  readonly hooks?: RunHooks<P>;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
  /** Where integrity evidence reports are written; never inside the project. Defaults to the OS temp directory. */
  readonly evidenceDirectory?: string;
}

export interface RecordedRun<P = undefined> {
  /** What the worker itself reported. */
  readonly result: WorkerResult;
  /** What `afterWorker` produced (e.g. changes and validation), when it ran. */
  readonly post: P | undefined;
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

/**
 * State changes that must happen in the same write as the run records, so
 * the run and the workflow never disagree on disk.
 */
export interface RunHooks<P = undefined> {
  /**
   * Applied together with the `running` record, under the same lock. May
   * throw to refuse the run (e.g. the task is no longer runnable); the worker
   * is then not started and nothing is written.
   */
  readonly onStart?: (state: ProjectState) => ProjectState;
  /**
   * Runs after the `running` record is written and before the worker starts
   * (inside the lease for edit runs), e.g. to capture a Git baseline. If it
   * throws, the worker is NOT started and the run is recorded as
   * `unavailable` with the reason.
   */
  readonly beforeWorker?: () => Promise<void>;
  /**
   * Runs after the worker whenever control state is intact (inside the lease
   * for edit runs), for every outcome — e.g. to capture changes (a failed
   * worker may still have edited files) and, after success, to validate.
   * Control state is verified again afterwards, since this may run project
   * code; a violation found then still overrides everything.
   */
  readonly afterWorker?: (result: WorkerResult) => Promise<P>;
  /**
   * Applied together with the final record. Receives Forge's verdict. Not
   * called when Forge fails closed (state untrusted), in which case the
   * workflow stays as `onStart` left it and must be recovered explicitly.
   */
  readonly onFinish?: (state: ProjectState, status: WorkerRunStatus, record: WorkerRunRecord, post: P | undefined) => ProjectState;
}

type Persist = (change: (state: ProjectState) => ProjectState) => Promise<ProjectState>;

/** A result for a run whose worker never started because preparation failed. */
function preparationFailure(options: RecordedRunOptions<unknown>, error: unknown, clock: () => Date): WorkerResult {
  return {
    workerId: options.worker.id,
    requestId: options.request.id,
    outcome: 'unavailable',
    summary: null,
    startedAt: clock().toISOString(),
    durationMs: 0,
    process: null,
    provider: {},
    diagnostics: [`Forge could not prepare the run, so the worker was not started: ${error instanceof Error ? error.message : String(error)}`],
  };
}

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
export async function runRecordedWorker<P = undefined>(options: RecordedRunOptions<P>): Promise<RecordedRun<P>> {
  const store = options.store ?? openStateStore(options.project);
  const clock = options.clock ?? (() => new Date());
  const running = runningRecord(options, clock);

  if (options.request.access !== 'edit') {
    await store.update((state) => {
      assertNotPaused(state, 'start a worker');
      return started(options, withRun(state, running));
    });
    const snapshot = await snapshotControlState(options.project.layout, 'metadata');
    const result = await prepareAndExecute(options, clock);
    return finish(options, clock, running, result, snapshot, (change) => store.update(change));
  }

  // Throws StateConflictError if another Forge process holds the lock: the worker is not started.
  const lease = await store.acquireLease();
  try {
    await lease.update((state) => {
      assertNotPaused(state, 'start a worker');
      return started(options, withRun(state, running));
    });
    const snapshot = await snapshotControlState(options.project.layout, 'full');
    const result = await prepareAndExecute(options, clock);
    return await finish(options, clock, running, result, snapshot, (change) => lease.update(change));
  } finally {
    // Removes the lock only if it is still ours; a replaced lock is left as evidence.
    await lease.release();
  }
}

async function finish<P>(
  options: RecordedRunOptions<P>,
  clock: () => Date,
  running: WorkerRunRecord,
  result: WorkerResult,
  snapshot: ControlSnapshot,
  persist: Persist,
): Promise<RecordedRun<P>> {
  let integrity = await verifyControlState(options.project, snapshot);
  let post: P | undefined;
  if (integrity.ok && options.hooks?.afterWorker !== undefined) {
    post = await options.hooks.afterWorker(result);
    integrity = await verifyControlState(options.project, snapshot);
  }
  const finished: WorkerRunRecord = {
    ...running,
    status: result.outcome,
    finishedAt: clock().toISOString(),
    durationMs: result.durationMs,
    // Provider text is persisted only after credential values from the environment are redacted.
    summary: result.summary === null ? null : truncate(redact(result.summary.trim()), WORKER_RUN_LIMITS.summary),
    diagnostic: result.diagnostics[0] === undefined ? null : excerpt(redact(result.diagnostics[0]), WORKER_RUN_LIMITS.diagnostic),
  };

  if (integrity.ok) {
    return save(options, result, post, result.outcome, integrity, undefined, finished, persist);
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
    return { result, post, status: 'integrity-violation', integrity, evidencePath, record: undefined, persistenceError: error };
  }
  return save(options, result, post, 'integrity-violation', integrity, evidencePath, violation, persist);
}

async function save<P>(
  options: RecordedRunOptions<P>,
  result: WorkerResult,
  post: P | undefined,
  status: WorkerRunStatus,
  integrity: IntegrityReport,
  evidencePath: string | undefined,
  record: WorkerRunRecord,
  persist: Persist,
): Promise<RecordedRun<P>> {
  try {
    await persist((state) => {
      const next = withRun(state, record);
      return options.hooks?.onFinish === undefined ? next : options.hooks.onFinish(next, status, record, post);
    });
    return { result, post, status, integrity, evidencePath, record, persistenceError: undefined };
  } catch (error) {
    const persistenceError = error instanceof Error ? error : new Error(String(error));
    return { result, post, status, integrity, evidencePath, record: undefined, persistenceError };
  }
}

async function prepareAndExecute<P>(options: RecordedRunOptions<P>, clock: () => Date): Promise<WorkerResult> {
  if (options.hooks?.beforeWorker !== undefined) {
    try {
      await options.hooks.beforeWorker();
    } catch (error) {
      return preparationFailure(options as RecordedRunOptions<unknown>, error, clock);
    }
  }
  return options.worker.execute(options.request, options.signal === undefined ? {} : { signal: options.signal });
}

function runningRecord<P>(options: RecordedRunOptions<P>, clock: () => Date): WorkerRunRecord {
  return {
    id: options.request.id,
    worker: options.worker.id,
    trigger: options.trigger,
    taskId: options.link?.taskId ?? null,
    attempt: options.link?.attempt ?? null,
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

function started<P>(options: RecordedRunOptions<P>, state: ProjectState): ProjectState {
  return options.hooks?.onStart === undefined ? state : options.hooks.onStart(state);
}

/** Inserts or replaces the run by ID. */
function withRun(state: ProjectState, run: WorkerRunRecord): ProjectState {
  const others = state.workerRuns.filter((existing) => existing.id !== run.id);
  const runs = [...others, run];
  // Manual runs are capped; task runs stay as long as the attempt that references them.
  const manual = runs.filter((candidate) => candidate.trigger === 'manual');
  const excess = Math.max(0, manual.length - WORKER_RUN_LIMITS.retainedRuns);
  const dropped = new Set(manual.slice(0, excess).map((candidate) => candidate.id));
  return { ...state, workerRuns: runs.filter((candidate) => !dropped.has(candidate.id)) };
}

/** Replaces values of credential-like environment variables before provider text is stored. */
function redact(text: string): string {
  return redactSecrets(text, secretValues(process.env));
}
