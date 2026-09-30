import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { WorkflowError } from '../core/errors.ts';
import { openStateStore } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { TASK_LIMITS } from '../state/index.ts';
import type { MilestoneRecord, ProjectState, StateStore, TaskRecord, WorkerAccessMode } from '../state/index.ts';
import { prepareWorkerRequest, runRecordedWorker } from '../workers/index.ts';
import type { RecordedRun, Worker, WorkerHealth } from '../workers/index.ts';
import { resolveMilestoneReference, resolveTaskReference } from './references.ts';
import * as transitions from './transitions.ts';
import { deriveWorkflow, processLiveness } from './view.ts';
import type { ExecutorLiveness, TaskView, WorkflowView } from './view.ts';

export interface TaskEngineOptions {
  readonly project: LoadedProject;
  readonly store?: StateStore;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly liveness?: ExecutorLiveness;
  /** Where integrity evidence is written for task runs (defaults to the OS temp directory). */
  readonly evidenceDirectory?: string;
}

export interface NewTaskInput {
  readonly milestone: string;
  readonly title: string;
  readonly instruction: string;
  readonly context?: string | null;
  /** Task references (IDs, prefixes, or ordinals). */
  readonly dependsOn?: readonly string[];
  readonly maxAttempts?: number;
}

export interface RunTaskOptions {
  readonly worker: Worker;
  readonly access: WorkerAccessMode;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly acknowledgeIntegrityViolation?: boolean;
}

export interface TaskRunOutcome {
  readonly run: RecordedRun;
  /** The task as persisted afterwards (undefined if state could not be read back). */
  readonly task: TaskView | undefined;
  readonly attempt: number;
}

/**
 * Deterministic work management for one project. Every mutation is a pure
 * transition (`transitions.ts`) applied via `StateStore.update`, so checks
 * always run against the latest state under the state lock, and concurrent
 * Forge processes cannot both succeed at conflicting changes.
 *
 * Locking: there is exactly one lock (the project state lock). Short
 * operations take it per write. `runTask` takes it twice for read-only
 * workers (start, finish) and holds it for the whole run for edit-enabled
 * workers (Milestone 3 integrity lease). No operation ever waits for the
 * lock while holding it, so there is no lock-ordering deadlock; a second
 * Forge process simply gets a lock conflict.
 *
 * `runTask` executes exactly one task and stops. Nothing here selects or
 * starts another task, retries automatically, or trusts worker prose.
 */
export class TaskEngine {
  private readonly project: LoadedProject;
  private readonly store: StateStore;
  private readonly clock: () => Date;
  private readonly generateId: () => string;
  private readonly liveness: ExecutorLiveness;
  private readonly evidenceDirectory: string | undefined;

  constructor(options: TaskEngineOptions) {
    this.project = options.project;
    this.store = options.store ?? openStateStore(options.project);
    this.clock = options.clock ?? (() => new Date());
    this.generateId = options.generateId ?? randomUUID;
    this.liveness = options.liveness ?? processLiveness;
    this.evidenceDirectory = options.evidenceDirectory;
  }

  async load(): Promise<ProjectState> {
    return this.store.load();
  }

  async view(): Promise<WorkflowView> {
    return deriveWorkflow(await this.store.load(), this.liveness);
  }

  async resolveMilestone(reference: string): Promise<string> {
    return resolveMilestoneReference(await this.store.load(), reference);
  }

  async resolveTask(reference: string): Promise<string> {
    return resolveTaskReference(await this.store.load(), reference);
  }

  async addMilestone(input: { readonly title: string; readonly description?: string | null }): Promise<MilestoneRecord> {
    const id = this.generateId();
    const state = await this.store.update((current) =>
      transitions.addMilestone(current, { id, title: input.title, description: input.description ?? null }, this.clock()),
    );
    return state.milestones.find((milestone) => milestone.id === id)!;
  }

  async addTask(input: NewTaskInput): Promise<TaskRecord> {
    const id = this.generateId();
    const state = await this.store.update((current) => {
      const milestoneId = resolveMilestoneReference(current, input.milestone);
      const dependsOn = (input.dependsOn ?? []).map((reference) => resolveTaskReference(current, reference));
      return transitions.addTask(
        current,
        {
          id,
          milestoneId,
          title: input.title,
          instruction: input.instruction,
          context: input.context ?? null,
          dependsOn,
          maxAttempts: input.maxAttempts ?? TASK_LIMITS.defaultMaxAttempts,
        },
        this.clock(),
      );
    });
    return state.tasks.find((task) => task.id === id)!;
  }

  async completeMilestone(reference: string): Promise<void> {
    await this.store.update((state) => transitions.completeMilestone(state, resolveMilestoneReference(state, reference), this.clock()));
  }

  async cancelMilestone(reference: string, reason: string | null): Promise<void> {
    await this.store.update((state) =>
      transitions.cancelMilestone(state, resolveMilestoneReference(state, reference), reason, this.clock()),
    );
  }

  async acceptTask(reference: string, note: string | null): Promise<void> {
    await this.store.update((state) => transitions.acceptTask(state, resolveTaskReference(state, reference), note, this.clock()));
  }

  async rejectTask(reference: string, reason: string): Promise<void> {
    await this.store.update((state) => transitions.rejectTask(state, resolveTaskReference(state, reference), reason, this.clock()));
  }

  async cancelTask(reference: string, reason: string | null): Promise<void> {
    await this.store.update((state) => transitions.cancelTask(state, resolveTaskReference(state, reference), reason, this.clock()));
  }

  async recoverTask(reference: string, options: { readonly force: boolean }): Promise<void> {
    await this.store.update((state) =>
      transitions.recoverTask(state, resolveTaskReference(state, reference), { force: options.force, liveness: this.liveness }, this.clock()),
    );
  }

  /**
   * Checks that the worker is usable. Called before an attempt is recorded
   * so a missing or logged-out worker does not consume the attempt budget.
   */
  async checkWorker(worker: Worker): Promise<WorkerHealth> {
    const health = await worker.healthCheck();
    if (!health.available) {
      const problems = health.checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
      throw new WorkflowError(`Worker "${worker.id}" is not available (${problems.join('; ') || 'unknown reason'}); no attempt was recorded`);
    }
    return health;
  }

  /**
   * Executes one attempt of one task, then stops:
   * validate runnable -> check worker -> (atomically) record attempt + run,
   * task -> running -> invoke worker -> (atomically) record verdict, task ->
   * awaiting-validation | failed.
   */
  async runTask(reference: string, options: RunTaskOptions): Promise<TaskRunOutcome> {
    const acknowledgeIntegrityViolation = options.acknowledgeIntegrityViolation === true;
    const state = await this.store.load();
    const taskId = resolveTaskReference(state, reference);
    const view = transitions.assertTaskCanStart(state, taskId, { acknowledgeIntegrityViolation, liveness: this.liveness });
    await this.checkWorker(options.worker);

    const attemptNumber = view.task.attempts.length + 1;
    const request = await prepareWorkerRequest({
      project: this.project,
      task: view.task.instruction,
      context: view.task.context,
      access: options.access,
      timeoutMs: options.timeoutMs,
      id: this.generateId(),
    });

    const run = await runRecordedWorker({
      worker: options.worker,
      request,
      project: this.project,
      store: this.store,
      trigger: 'task',
      link: { taskId, attempt: attemptNumber },
      hooks: {
        onStart: (current) =>
          transitions.startAttempt(
            current,
            {
              taskId,
              runId: request.id,
              attemptNumber,
              executor: { pid: process.pid, host: hostname() },
              acknowledgeIntegrityViolation,
              liveness: this.liveness,
            },
            this.clock(),
          ),
        onFinish: (current, status) => transitions.finishAttempt(current, taskId, request.id, status, this.clock()),
      },
      clock: this.clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(this.evidenceDirectory === undefined ? {} : { evidenceDirectory: this.evidenceDirectory }),
    });

    const after = await this.view().catch(() => undefined);
    return { run, task: after?.task(taskId), attempt: attemptNumber };
  }
}
