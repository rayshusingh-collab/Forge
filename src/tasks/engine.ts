import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { GitError, IntegrityError, WorkflowError } from '../core/errors.ts';
import { ProcessRunner } from '../execution/index.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient, captureChanges, carryForwardBaseline, fingerprintPath, inScope, takeSnapshot } from '../git/index.ts';
import { describeIntegrityChanges, openStateStore, snapshotControlState, verifyControlState } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { TASK_LIMITS } from '../state/index.ts';
import type {
  AttemptOrigin,
  ChangeSummary,
  CommitRecord,
  GitBaseline,
  MilestoneRecord,
  ProjectState,
  StateStore,
  TaskRecord,
  ValidationRecord,
  WorkerAccessMode,
} from '../state/index.ts';
import { ValidationProfileStore, runValidation } from '../validation/index.ts';
import type { ValidationProfile } from '../validation/index.ts';
import { prepareWorkerRequest, runRecordedWorker } from '../workers/index.ts';
import type { RecordedRun, Worker, WorkerHealth } from '../workers/index.ts';
import { commitEligibility, decideBeforeValidation, decideFromValidation } from './decision.ts';
import type { PostExecution } from './decision.ts';
import { resolveMilestoneReference, resolveTaskReference } from './references.ts';
import * as transitions from './transitions.ts';
import { deriveWorkflow, processLiveness } from './view.ts';
import type { ExecutorLiveness, TaskView, WorkflowView } from './view.ts';

export interface TaskEngineOptions {
  readonly project: LoadedProject;
  readonly store?: StateStore;
  /** Runs Git and validation commands. */
  readonly runner?: ProcessExecutor;
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
  /** Set by the orchestrator (`forge run`); absent for a manual `forge task run`. */
  readonly origin?: AttemptOrigin;
  /** Forge-built evidence for a repair attempt; requires `origin.repair`. */
  readonly repairEvidence?: string;
}

export interface TaskRunOutcome {
  readonly run: RecordedRun<PostExecution>;
  /** The task as persisted afterwards (undefined if state could not be read back). */
  readonly task: TaskView | undefined;
  readonly attempt: number;
}

export interface ValidateTaskOutcome {
  readonly post: PostExecution;
  readonly task: TaskView | undefined;
}

export interface CommitOutcome {
  readonly commit: CommitRecord;
  readonly paths: readonly string[];
  readonly message: string;
}

/**
 * Deterministic work management for one project. Every mutation is a pure
 * transition (`transitions.ts`) applied via `StateStore.update` or a lease,
 * so checks always run against the latest state under the state lock.
 *
 * Trust model: worker output is a claim; validator output is evidence;
 * Forge's workflow state is the decision. A task succeeds only when the
 * required deterministic checks Forge ran pass (or a human overrides it
 * explicitly, with a recorded reason).
 *
 * Locking: there is exactly one lock (the project state lock). Short
 * operations take it per write. Edit-enabled `runTask`, `validateTask`, and
 * `commitTask` hold it for their whole duration (integrity lease), so no
 * other Forge process can change the repository's Forge-managed state or
 * start another edit run meanwhile. No operation waits for the lock while
 * holding it, so there is no deadlock; a second Forge process gets a lock
 * conflict.
 *
 * `runTask` executes exactly one task and stops. Nothing here selects or
 * starts another task, retries automatically, or trusts worker prose.
 */
export class TaskEngine {
  private readonly project: LoadedProject;
  private readonly store: StateStore;
  private readonly runner: ProcessExecutor;
  private readonly profiles: ValidationProfileStore;
  private readonly clock: () => Date;
  private readonly generateId: () => string;
  private readonly liveness: ExecutorLiveness;
  private readonly evidenceDirectory: string | undefined;

  constructor(options: TaskEngineOptions) {
    this.project = options.project;
    this.store = options.store ?? openStateStore(options.project);
    this.runner = options.runner ?? new ProcessRunner({ defaultTimeoutMs: 120_000 });
    this.clock = options.clock ?? (() => new Date());
    this.profiles = new ValidationProfileStore(options.project.layout, { clock: this.clock });
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

  /** Audited human override of a task awaiting validation. Never applies to failed validation. */
  async overrideTask(reference: string, reason: string): Promise<void> {
    await this.store.update((state) => transitions.overrideTask(state, resolveTaskReference(state, reference), reason, this.clock()));
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

  async validationProfile(): Promise<ValidationProfile> {
    return this.profiles.load();
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
   * Executes one attempt of one task, then stops. For edit-enabled runs,
   * inside the state lease:
   *   record attempt (running) -> Git baseline -> worker -> .forge integrity
   *   -> changeset + scope check -> deterministic validation -> integrity
   *   re-check -> one atomic write of Forge's decision.
   * Read-only runs cannot produce code, so they end awaiting validation.
   */
  async runTask(reference: string, options: RunTaskOptions): Promise<TaskRunOutcome> {
    const acknowledgeIntegrityViolation = options.acknowledgeIntegrityViolation === true;
    const state = await this.store.load();
    const taskId = resolveTaskReference(state, reference);
    const view = transitions.assertTaskCanStart(state, taskId, { acknowledgeIntegrityViolation, liveness: this.liveness });
    if ((options.repairEvidence !== undefined) !== (options.origin?.repair != null)) {
      throw new WorkflowError('Repair evidence and a repair record must be supplied together');
    }

    // Everything that can be checked without side effects is checked before
    // an attempt is recorded, so these problems never consume the budget.
    const profile = await this.profiles.load();
    const git = options.access === 'edit' ? await this.gitClient() : undefined;
    if (git !== undefined) {
      await refuseUnmergedPaths(git);
    }
    await this.checkWorker(options.worker);

    const attemptNumber = view.task.attempts.length + 1;
    const request = await prepareWorkerRequest({
      project: this.project,
      task: view.task.instruction,
      context: view.task.context,
      repairEvidence: options.repairEvidence ?? null,
      access: options.access,
      timeoutMs: options.timeoutMs,
      id: this.generateId(),
    });

    let baseline: GitBaseline | undefined;
    const run = await runRecordedWorker<PostExecution>({
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
              origin: options.origin ?? null,
            },
            this.clock(),
          ),
        ...(git === undefined
          ? {}
          : {
              beforeWorker: async () => {
                await refuseUnmergedPaths(git);
                // Retries keep attributing earlier attempts' edits to the task.
                const history = view.task.attempts;
                baseline = carryForwardBaseline(
                  history.find((attempt) => attempt.changes !== null)?.changes?.baseline ?? null,
                  history.at(-1)?.changes ?? null,
                  await takeSnapshot(git),
                  this.clock(),
                );
              },
            }),
        afterWorker: async (result) => {
          if (git === undefined || baseline === undefined) {
            return decideBeforeValidation(null, { access: options.access, requiredChecks: requiredCount(profile) })!;
          }
          if (result.outcome !== 'success') {
            // Record what a failed worker changed (for the next attempt), but never validate it.
            const changes = await captureChanges(git, baseline, request.relativeWorkingDirectory, this.clock()).catch(() => null);
            return { changes, validation: null, decision: 'awaiting-validation', note: null };
          }
          return this.evaluate(git, baseline, request.relativeWorkingDirectory, profile, options.access, options.signal);
        },
        onFinish: (current, status, _record, post) =>
          transitions.finishAttempt(current, taskId, request.id, status, this.clock(), post),
      },
      clock: this.clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(this.evidenceDirectory === undefined ? {} : { evidenceDirectory: this.evidenceDirectory }),
    });

    const after = await this.view().catch(() => undefined);
    return { run, task: after?.task(taskId), attempt: attemptNumber };
  }

  /**
   * Re-runs deterministic validation for a task awaiting validation (e.g.
   * after configuring checks, or after validation was cancelled). Does not
   * invoke a worker or consume an attempt. Runs under the state lease with
   * the same `.forge/` integrity verification as a worker run.
   */
  async validateTask(reference: string, options: { readonly signal?: AbortSignal } = {}): Promise<ValidateTaskOutcome> {
    const lease = await this.store.acquireLease();
    try {
      const state = await this.store.load();
      const taskId = resolveTaskReference(state, reference);
      const task = state.tasks.find((candidate) => candidate.id === taskId)!;
      const last = task.attempts.at(-1);
      if (task.status !== 'awaiting-validation' || last === undefined) {
        throw new WorkflowError(`Task "${task.title}" is ${task.status}; only a task awaiting validation can be validated`);
      }
      const profile = await this.profiles.load();
      const scope = state.workerRuns.find((candidate) => candidate.id === last.runId)?.workingDirectory ?? '.';

      const snapshot = await snapshotControlState(this.project.layout, 'full');
      let post: PostExecution;
      if (last.changes !== null) {
        const git = await this.gitClient();
        post = await this.evaluate(git, last.changes.baseline, scope, profile, 'edit', options.signal);
      } else if (requiredCount(profile) === 0) {
        post = decideBeforeValidation(null, { access: 'edit', requiredChecks: 0 })!;
      } else {
        // A read-only task was explicitly submitted for validation.
        const validation = await this.validate(profile, options.signal);
        post = decideFromValidation(null, validation);
      }

      const integrity = await verifyControlState(this.project, snapshot);
      if (!integrity.ok) {
        throw new IntegrityError(
          `Forge control state changed during validation (${describeIntegrityChanges(integrity)}); nothing was recorded. Inspect .forge/.`,
        );
      }
      await lease.update((current) => transitions.recordValidation(current, taskId, last.number, post, this.clock()));
      return { post, task: (await this.view()).task(taskId) };
    } finally {
      await lease.release();
    }
  }

  /**
   * Creates one local commit containing exactly the validated task's
   * attributed changes, after re-verifying them against the live
   * repository. Never stages unrelated files, never includes `.forge/` or
   * `.git/`, never pushes. Refuses whenever attribution is not certain.
   */
  async commitTask(reference: string): Promise<CommitOutcome> {
    const lease = await this.store.acquireLease();
    try {
      const state = await this.store.load();
      const taskId = resolveTaskReference(state, reference);
      const view = deriveWorkflow(state, this.liveness).task(taskId)!;
      const attempt = view.lastAttempt;
      if (view.task.status !== 'succeeded') {
        throw new WorkflowError(`Task ${view.key} is ${view.task.status}; only a validated, succeeded task can be committed`);
      }
      const eligibility = commitEligibility(attempt);
      if (!eligibility.ok) {
        throw new WorkflowError(`Task ${view.key} cannot be committed: ${eligibility.reason}`);
      }
      const changes = attempt!.changes!;
      const git = await this.gitClient();
      const paths = await verifyCommittable(git, changes);

      const message = commitMessage(view, attempt!.number, attempt!.validation);
      const added = changes.files.filter((file) => file.change === 'added').map((file) => file.path);
      await git.addPaths(added);
      let sha: string;
      try {
        sha = await git.commitOnly(paths, message);
      } catch (error) {
        // Undo only Forge's own staging of new files; working files are untouched.
        await git.unstageNewPaths(added).catch(() => undefined);
        throw error;
      }

      const committed = new Set(await git.commitPaths(sha));
      const parent = await git.parentOf(sha);
      const commit: CommitRecord = { sha, paths: paths.length, committedAt: this.clock().toISOString() };
      await lease.update((current) => transitions.recordCommit(current, taskId, attempt!.number, commit, this.clock()));
      if (parent !== changes.head || committed.size !== paths.length || paths.some((path) => !committed.has(path))) {
        throw new GitError(
          `Commit ${sha.slice(0, 12)} was created but does not match the expected change (a repository hook may have altered it); inspect it with \`git show ${sha.slice(0, 12)}\``,
        );
      }
      return { commit, paths, message };
    } finally {
      await lease.release();
    }
  }

  /** Changeset, scope check, and (when applicable) validation, as Forge's evidence. */
  private async evaluate(
    git: GitClient,
    baseline: GitBaseline,
    scope: string,
    profile: ValidationProfile,
    access: WorkerAccessMode,
    signal: AbortSignal | undefined,
  ): Promise<PostExecution> {
    let changes: ChangeSummary;
    try {
      changes = await captureChanges(git, baseline, scope, this.clock());
    } catch (error) {
      return { changes: null, validation: null, decision: 'awaiting-validation', note: `changes could not be captured: ${describe(error)}` };
    }
    const early = decideBeforeValidation(changes, { access, requiredChecks: requiredCount(profile) });
    if (early !== null) {
      return early;
    }
    return decideFromValidation(changes, await this.validate(profile, signal));
  }

  private validate(profile: ValidationProfile, signal: AbortSignal | undefined): Promise<ValidationRecord> {
    return runValidation(profile, {
      project: this.project,
      runner: this.runner,
      clock: this.clock,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private gitClient(): Promise<GitClient> {
    return GitClient.create({ runner: this.runner, root: this.project.layout.root });
  }
}

function requiredCount(profile: ValidationProfile): number {
  return profile.checks.filter((check) => check.required).length;
}

async function refuseUnmergedPaths(git: GitClient): Promise<void> {
  const status = await git.status();
  const unmerged = status.entries.filter((entry) => entry.kind === 'unmerged');
  if (unmerged.length > 0) {
    throw new WorkflowError(`The repository has unresolved merge conflicts (${unmerged.slice(0, 3).map((e) => e.path).join(', ')}); resolve them first`);
  }
}

/**
 * Re-checks the recorded changeset against the live repository; returns the
 * exact paths to commit. Any drift since validation is a refusal.
 */
async function verifyCommittable(git: GitClient, changes: ChangeSummary): Promise<string[]> {
  const status = await git.status();
  if (status.head !== changes.head || status.branch !== changes.branch) {
    throw new WorkflowError('HEAD or the current branch changed since the task was validated; refusing to commit');
  }
  if (status.entries.some((entry) => entry.kind === 'unmerged')) {
    throw new WorkflowError('The repository has unresolved merge conflicts; refusing to commit');
  }
  const entries = new Map(status.entries.map((entry) => [entry.path, entry]));
  const paths: string[] = [];
  for (const file of changes.files) {
    if (!inScope(file.path, '.')) {
      throw new WorkflowError(`Refusing to commit protected path ${file.path}`);
    }
    const entry = entries.get(file.path);
    if ((await fingerprintPath(git.root, file.path)) !== file.fingerprint) {
      throw new WorkflowError(`${file.path} changed after the task was validated; validate again (or commit it yourself)`);
    }
    const expected =
      file.change === 'added'
        ? entry?.kind === 'untracked'
        : file.change === 'deleted'
          ? entry?.kind === 'tracked' && entry.index === '.' && entry.worktree === 'D'
          : entry?.kind === 'tracked' && entry.index === '.' && entry.worktree !== '.';
    if (!expected) {
      throw new WorkflowError(`${file.path} no longer has the expected, unstaged ${file.change} change; refusing to commit`);
    }
    paths.push(file.path);
  }
  return paths;
}

/** Deterministic message from Forge's own records — never from worker output. */
export function commitMessage(view: TaskView, attempt: number, validation: ValidationRecord | null): string {
  const title = view.task.title.replace(/\s+/g, ' ').trim();
  const subject = `forge: complete task ${view.key} - ${title}`;
  const checks = validation?.checks.filter((check) => check.status === 'passed').map((check) => check.id) ?? [];
  return [
    subject.length <= 100 ? subject : `${subject.slice(0, 99)}…`,
    '',
    `Forge-Task: ${view.task.id}`,
    `Forge-Attempt: ${attempt}`,
    `Forge-Validation: passed (${checks.join(', ')})`,
    '',
  ].join('\n');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
