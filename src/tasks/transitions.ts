import { WorkflowError } from '../core/errors.ts';
import { TASK_LIMITS, describeDependencyProblem, findDependencyProblem } from '../state/index.ts';
import type {
  AttemptExecutor,
  AttemptOrigin,
  AttemptOutcome,
  RepairRecord,
  CommitRecord,
  MilestoneRecord,
  MilestoneStatus,
  ProjectState,
  TaskAttempt,
  TaskRecord,
  TaskStatus,
  WorkerRunRecord,
  WorkerRunStatus,
} from '../state/index.ts';
import type { PostExecution } from './decision.ts';
import { deriveWorkflow } from './view.ts';
import type { ExecutorLiveness, TaskView } from './view.ts';

/**
 * The task & milestone state machine. This module is the only place that
 * changes milestone or task status. Every function is a pure
 * `ProjectState -> ProjectState` transformation that either returns the next
 * state or throws `WorkflowError`; callers apply them through
 * `StateStore.update`, so each check runs against the latest state under the
 * state lock. Workers never call these: Forge decides transitions from the
 * structured result a worker returns.
 */

/** Legal stored task transitions. Anything not listed is rejected. */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'awaiting-validation', 'failed'],
  'awaiting-validation': ['succeeded', 'failed'],
  failed: ['running', 'cancelled'],
  // Only via an explicit human remediation decision after an AI review (reopenForRemediation).
  succeeded: ['failed'],
  cancelled: [],
};

/** Legal milestone transitions. Anything not listed is rejected. */
export const MILESTONE_TRANSITIONS: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  pending: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/**
 * Worker verdict -> attempt outcome, before Forge's own checks. A worker
 * `success` only means the invocation completed; what happens next is
 * decided from Forge-collected evidence (see `decision.ts`). Every other
 * verdict fails the attempt (and still consumes it).
 */
export function attemptOutcomeForRun(status: WorkerRunStatus): AttemptOutcome {
  switch (status) {
    case 'success':
      return 'awaiting-validation';
    case 'running':
      throw new WorkflowError('A running worker run has no final outcome yet');
    default:
      return status;
  }
}

export function taskStatusForOutcome(outcome: AttemptOutcome): TaskStatus {
  switch (outcome) {
    case 'awaiting-validation':
      return 'awaiting-validation';
    case 'validated':
    case 'overridden':
    case 'accepted':
      return 'succeeded';
    default:
      return 'failed';
  }
}

// ---------------------------------------------------------------- milestones

export interface NewMilestone {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
}

export function addMilestone(state: ProjectState, input: NewMilestone, now: Date): ProjectState {
  const title = requireText(input.title, 'Milestone title', TASK_LIMITS.title);
  const description = optionalText(input.description, 'Milestone description', TASK_LIMITS.description);
  const order = Math.max(0, ...state.milestones.map((milestone) => milestone.order)) + 1;
  const timestamp = now.toISOString();
  const milestone: MilestoneRecord = {
    id: input.id,
    order,
    title,
    description,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { ...state, milestones: [...state.milestones, milestone] };
}

export function completeMilestone(state: ProjectState, milestoneId: string, now: Date): ProjectState {
  const milestone = findMilestone(state, milestoneId);
  const view = deriveWorkflow(state, () => true).milestone(milestoneId)!;
  if (!view.canComplete) {
    const unfinished = view.tasks.filter((task) => task.task.status !== 'succeeded' && task.task.status !== 'cancelled');
    throw new WorkflowError(
      unfinished.length > 0
        ? `Milestone "${milestone.title}" cannot be completed: ${unfinished.length} task(s) are not finished (${unfinished.map(describeView).join(', ')})`
        : `Milestone "${milestone.title}" cannot be completed: it has no succeeded tasks`,
    );
  }
  return withMilestone(state, milestone, 'completed', now);
}

/** Cancels the milestone and its unfinished tasks. Refused while a task is running or awaiting validation. */
export function cancelMilestone(state: ProjectState, milestoneId: string, reason: string | null, now: Date): ProjectState {
  const milestone = findMilestone(state, milestoneId);
  assertMilestoneTransition(milestone, 'cancelled');
  const tasks = state.tasks.filter((task) => task.milestoneId === milestoneId);
  const busy = tasks.filter((task) => task.status === 'running' || task.status === 'awaiting-validation');
  if (busy.length > 0) {
    throw new WorkflowError(
      `Milestone "${milestone.title}" has ${busy.length} task(s) running or awaiting validation; finish, accept/reject, or recover them first`,
    );
  }
  const note = optionalText(reason, 'Cancellation reason', TASK_LIMITS.note);
  let next = withMilestone(state, milestone, 'cancelled', now);
  for (const task of tasks) {
    if (task.status === 'pending' || task.status === 'failed') {
      next = replaceTask(next, withStatus(task, 'cancelled', now, { cancelReason: note ?? `milestone "${milestone.title}" cancelled` }));
    }
  }
  return next;
}

// --------------------------------------------------------------------- tasks

export interface NewTask {
  readonly id: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly instruction: string;
  readonly context: string | null;
  readonly dependsOn: readonly string[];
  readonly maxAttempts: number;
}

export function addTask(state: ProjectState, input: NewTask, now: Date): ProjectState {
  const milestone = findMilestone(state, input.milestoneId);
  if (milestone.status !== 'pending' && milestone.status !== 'active') {
    throw new WorkflowError(`Cannot add tasks to ${milestone.status} milestone "${milestone.title}"`);
  }
  const title = requireText(input.title, 'Task title', TASK_LIMITS.title);
  const instruction = requireText(input.instruction, 'Task instruction', TASK_LIMITS.instruction);
  const context = optionalText(input.context, 'Task context', TASK_LIMITS.context);
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > TASK_LIMITS.maxAttempts) {
    throw new WorkflowError(`Maximum attempts must be between 1 and ${TASK_LIMITS.maxAttempts}`);
  }
  if (input.dependsOn.length > TASK_LIMITS.dependencies) {
    throw new WorkflowError(`A task may have at most ${TASK_LIMITS.dependencies} dependencies`);
  }
  for (const dependencyId of input.dependsOn) {
    const dependency = state.tasks.find((task) => task.id === dependencyId);
    if (dependency?.status === 'cancelled') {
      throw new WorkflowError(`Cannot depend on cancelled task "${dependency.title}"`);
    }
  }

  const order = Math.max(0, ...state.tasks.filter((task) => task.milestoneId === milestone.id).map((task) => task.order)) + 1;
  const timestamp = now.toISOString();
  const task: TaskRecord = {
    id: input.id,
    milestoneId: milestone.id,
    order,
    title,
    instruction,
    context,
    status: 'pending',
    dependsOn: [...input.dependsOn],
    maxAttempts: input.maxAttempts,
    attempts: [],
    cancelReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const next = { ...state, tasks: [...state.tasks, task] };
  const problem = findDependencyProblem(next.tasks);
  if (problem !== null) {
    throw new WorkflowError(`Invalid dependencies: ${describeDependencyProblem(problem)}`);
  }
  return next;
}

export interface StartAttemptInput {
  readonly taskId: string;
  /** The worker run executing this attempt; must already be in `state.workerRuns`. */
  readonly runId: string;
  /** Attempt number the caller prepared for; a mismatch means someone else started the task. */
  readonly attemptNumber: number;
  readonly executor: AttemptExecutor;
  readonly acknowledgeIntegrityViolation: boolean;
  readonly liveness: ExecutorLiveness;
  /** Set by the orchestrator; null/absent for a manual `forge task run`. */
  readonly origin?: AttemptOrigin | null;
}

/**
 * Checks that a task may start now and returns its view. Used both before
 * starting (for a clear early error) and inside the start transition.
 */
export function assertTaskCanStart(
  state: ProjectState,
  taskId: string,
  options: { readonly acknowledgeIntegrityViolation: boolean; readonly liveness: ExecutorLiveness },
): TaskView {
  findTask(state, taskId);
  const view = deriveWorkflow(state, options.liveness).task(taskId)!;
  if (!view.runnable) {
    throw new WorkflowError(`Task ${view.key} "${view.task.title}" is not runnable: ${explainNotRunnable(view, state)}`);
  }
  if (view.requiresIntegrityAcknowledgement && !options.acknowledgeIntegrityViolation) {
    throw new WorkflowError(
      `Task ${view.key}'s last attempt ended in a ${view.lastAttempt?.outcome} (${view.lastAttempt?.note ?? 'protected state or scope was violated'}). ` +
        'Inspect the project, then retry with --acknowledge-integrity-violation.',
    );
  }
  return view;
}

/** pending|failed -> running: records a new attempt linked to its worker run. */
export function startAttempt(state: ProjectState, input: StartAttemptInput, now: Date): ProjectState {
  const view = assertTaskCanStart(state, input.taskId, input);
  const task = view.task;
  if (task.attempts.length + 1 !== input.attemptNumber) {
    throw new WorkflowError(`Task ${view.key} was started by another Forge process; reload and check its status`);
  }
  const origin = input.origin ?? null;
  if (origin?.repair != null) {
    assertRepairMatches(task, origin.repair);
  }
  const attempt: TaskAttempt = {
    number: input.attemptNumber,
    runId: input.runId,
    outcome: 'running',
    executor: input.executor,
    startedAt: now.toISOString(),
    finishedAt: null,
    note: null,
    changes: null,
    validation: null,
    commit: null,
    origin,
  };
  let next = replaceTask(state, withStatus(task, 'running', now, { attempts: [...task.attempts, attempt] }));
  const milestone = findMilestone(next, task.milestoneId);
  if (milestone.status === 'pending') {
    next = withMilestone(next, milestone, 'active', now);
  }
  return next;
}

/**
 * running -> succeeded | awaiting-validation | failed, from Forge's verdict
 * on the worker run plus, when the worker succeeded, Forge's own evidence
 * (changeset and validation).
 */
export function finishAttempt(
  state: ProjectState,
  taskId: string,
  runId: string,
  status: WorkerRunStatus,
  now: Date,
  post?: PostExecution,
): ProjectState {
  const task = findTask(state, taskId);
  const last = task.attempts.at(-1);
  if (task.status !== 'running' || last === undefined || last.runId !== runId || last.outcome !== 'running') {
    throw new WorkflowError(`Task "${task.title}" is no longer running this attempt (it was changed by another Forge process)`);
  }
  const workerOutcome = attemptOutcomeForRun(status);
  if (workerOutcome !== 'awaiting-validation' || post === undefined) {
    const finished = finishLastAttempt(task, workerOutcome, null, now, taskStatusForOutcome(workerOutcome));
    // A failed worker may still have changed files; keep that evidence (never validated).
    return replaceTask(state, post?.changes == null ? finished : withLastAttempt(finished, { changes: post.changes }));
  }
  const outcome: AttemptOutcome = post.decision;
  const finished = finishLastAttempt(task, outcome, bounded(post.note), now, taskStatusForOutcome(outcome));
  return replaceTask(state, withLastAttempt(finished, { changes: post.changes, validation: post.validation }));
}

/**
 * Records a re-run of validation for a task awaiting validation:
 * awaiting-validation -> succeeded | failed, or stays awaiting validation
 * (with fresh evidence) when validation did not complete.
 */
export function recordValidation(state: ProjectState, taskId: string, attemptNumber: number, post: PostExecution, now: Date): ProjectState {
  const task = findTask(state, taskId);
  const last = task.attempts.at(-1);
  if (task.status !== 'awaiting-validation' || last === undefined || last.number !== attemptNumber) {
    throw new WorkflowError(`Task "${task.title}" is no longer awaiting validation of attempt ${attemptNumber}`);
  }
  const evidence = { changes: post.changes ?? last.changes, validation: post.validation ?? last.validation, note: bounded(post.note) };
  if (post.decision === 'awaiting-validation') {
    return replaceTask(state, { ...withLastAttempt(task, evidence), updatedAt: now.toISOString() });
  }
  const resolved = withLastAttempt(task, { ...evidence, outcome: post.decision });
  return replaceTask(state, withStatus(resolved, taskStatusForOutcome(post.decision), now));
}

/**
 * awaiting-validation -> succeeded WITHOUT passing validation. An explicit,
 * audited human decision (the reason is stored); never available for a task
 * whose validation failed, which is `failed`, not awaiting validation.
 */
export function overrideTask(state: ProjectState, taskId: string, reason: string, now: Date): ProjectState {
  const task = findTask(state, taskId);
  if (task.status !== 'awaiting-validation') {
    throw new WorkflowError(
      `Task "${task.title}" is ${task.status}; only a task awaiting validation can be overridden (failed validation cannot be overridden)`,
    );
  }
  const note = requireText(reason, 'Override reason', TASK_LIMITS.note);
  return replaceTask(state, resolveLastAttempt(task, 'overridden', `override: ${note}`, now, 'succeeded'));
}

/**
 * succeeded -> failed, ONLY as an explicit human decision after an AI
 * review ("remediation required"). The attempt keeps its validation evidence
 * and is marked `review-rejected`; the task becomes retryable if attempts
 * remain. Refused when dependents already ran on top of it or its milestone
 * is completed — create a follow-up task instead.
 */
export function reopenForRemediation(state: ProjectState, taskId: string, attemptNumber: number, reason: string, now: Date): ProjectState {
  const task = findTask(state, taskId);
  const last = task.attempts.at(-1);
  if (task.status !== 'succeeded' || last === undefined || last.number !== attemptNumber || last.outcome !== 'validated') {
    throw new WorkflowError(`Task "${task.title}" is not a validated, succeeded task at attempt ${attemptNumber}; it cannot be reopened`);
  }
  const executedDependents = state.tasks.filter((candidate) => candidate.dependsOn.includes(taskId) && candidate.attempts.length > 0);
  if (executedDependents.length > 0) {
    throw new WorkflowError(
      `Task "${task.title}" cannot be reopened: dependent task(s) already ran on top of it (${executedDependents.map((t) => `"${t.title}"`).join(', ')}); add a follow-up task instead`,
    );
  }
  if (findMilestone(state, task.milestoneId).status === 'completed') {
    throw new WorkflowError(`Task "${task.title}" belongs to a completed milestone; add a follow-up task instead`);
  }
  const note = requireText(reason, 'Remediation reason', TASK_LIMITS.note);
  return replaceTask(state, resolveLastAttempt(task, 'review-rejected', `review remediation: ${note}`, now, 'failed'));
}

/** Records the local commit Forge created for a validated task. */
export function recordCommit(state: ProjectState, taskId: string, attemptNumber: number, commit: CommitRecord, now: Date): ProjectState {
  const task = findTask(state, taskId);
  const last = task.attempts.at(-1);
  if (task.status !== 'succeeded' || last === undefined || last.number !== attemptNumber || last.outcome !== 'validated' || last.commit !== null) {
    throw new WorkflowError(`Task "${task.title}" changed before its commit could be recorded`);
  }
  return replaceTask(state, { ...withLastAttempt(task, { commit }), updatedAt: now.toISOString() });
}

/** awaiting-validation -> failed. The attempt stays consumed; a retry must be requested explicitly. */
export function rejectTask(state: ProjectState, taskId: string, reason: string, now: Date): ProjectState {
  const task = findTask(state, taskId);
  if (task.status !== 'awaiting-validation') {
    throw new WorkflowError(`Task "${task.title}" is ${task.status}; only a task awaiting validation can be rejected`);
  }
  const note = requireText(reason, 'Rejection reason', TASK_LIMITS.note);
  return replaceTask(state, resolveLastAttempt(task, 'rejected', note, now, 'failed'));
}

/** pending|failed -> cancelled. Running and awaiting-validation tasks must be resolved first. */
export function cancelTask(state: ProjectState, taskId: string, reason: string | null, now: Date): ProjectState {
  const task = findTask(state, taskId);
  if (task.status === 'running') {
    throw new WorkflowError(
      `Task "${task.title}" is running; stop the execution (Ctrl+C in its terminal) or, if it was interrupted, run \`forge task recover\``,
    );
  }
  if (task.status === 'awaiting-validation') {
    throw new WorkflowError(`Task "${task.title}" is awaiting validation; accept or reject it first`);
  }
  assertTaskTransition(task, 'cancelled');
  const cancelReason = optionalText(reason, 'Cancellation reason', TASK_LIMITS.note) ?? 'cancelled by user';
  return replaceTask(state, withStatus(task, 'cancelled', now, { cancelReason }));
}

/**
 * running -> failed for an execution whose Forge process is gone. The
 * attempt and its worker run are marked `interrupted`; nothing is re-run and
 * no success is inferred. `force` skips the liveness check (e.g. for an
 * execution recorded on another machine).
 */
export function recoverTask(
  state: ProjectState,
  taskId: string,
  options: { readonly force: boolean; readonly liveness: ExecutorLiveness },
  now: Date,
): ProjectState {
  const task = findTask(state, taskId);
  const view = deriveWorkflow(state, options.liveness).task(taskId)!;
  if (task.status !== 'running') {
    throw new WorkflowError(`Task ${view.key} is ${task.status}; only an interrupted running task needs recovery`);
  }
  if (view.condition !== 'interrupted' && !options.force) {
    throw new WorkflowError(
      `Task ${view.key} appears to still be running (its Forge process is alive); use --force only if you are sure it is not`,
    );
  }
  const last = task.attempts.at(-1)!;
  const note = 'Forge stopped before recording an outcome; recovered without inferring success';
  const next = replaceTask(state, finishLastAttempt(task, 'interrupted', note, now, 'failed'));
  const runs = next.workerRuns.map((run): WorkerRunRecord =>
    run.id === last.runId && run.status === 'running'
      ? { ...run, status: 'interrupted', finishedAt: now.toISOString(), diagnostic: note }
      : run,
  );
  return { ...next, workerRuns: runs };
}

/** Number of repair attempts already made for the task (the per-task repair budget is counted across runs). */
export function repairsUsed(task: TaskRecord): number {
  return task.attempts.filter((attempt) => attempt.origin?.repair != null).length;
}

/**
 * A repair must follow directly from the failed attempt whose evidence
 * triggered it; anything else would misattribute the repair.
 */
function assertRepairMatches(task: TaskRecord, repair: RepairRecord): void {
  const last = task.attempts.at(-1);
  const expected = repair.trigger === 'validation' ? 'validation-failed' : 'review-rejected';
  if (task.status !== 'failed' || last === undefined || last.number !== repair.fromAttempt || last.outcome !== expected) {
    throw new WorkflowError(`Task "${task.title}" changed: its latest attempt is no longer the ${expected} attempt ${repair.fromAttempt} being repaired`);
  }
  if (repair.number !== repairsUsed(task) + 1) {
    throw new WorkflowError(`Task "${task.title}" changed: repair ${repair.number} does not follow its ${repairsUsed(task)} earlier repair(s)`);
  }
}

// ------------------------------------------------------------------- helpers

export function assertTaskTransition(task: TaskRecord, to: TaskStatus): void {
  if (!TASK_TRANSITIONS[task.status].includes(to)) {
    throw new WorkflowError(`Illegal task transition for "${task.title}": ${task.status} -> ${to}`);
  }
}

export function assertMilestoneTransition(milestone: MilestoneRecord, to: MilestoneStatus): void {
  if (!MILESTONE_TRANSITIONS[milestone.status].includes(to)) {
    throw new WorkflowError(`Illegal milestone transition for "${milestone.title}": ${milestone.status} -> ${to}`);
  }
}

function withStatus(task: TaskRecord, to: TaskStatus, now: Date, changes: Partial<TaskRecord> = {}): TaskRecord {
  assertTaskTransition(task, to);
  return { ...task, ...changes, status: to, updatedAt: now.toISOString() };
}

function withMilestone(state: ProjectState, milestone: MilestoneRecord, to: MilestoneStatus, now: Date): ProjectState {
  assertMilestoneTransition(milestone, to);
  const updated: MilestoneRecord = { ...milestone, status: to, updatedAt: now.toISOString() };
  return { ...state, milestones: state.milestones.map((candidate) => (candidate.id === milestone.id ? updated : candidate)) };
}

function finishLastAttempt(task: TaskRecord, outcome: AttemptOutcome, note: string | null, now: Date, to: TaskStatus): TaskRecord {
  const attempts = task.attempts.map((attempt, index) =>
    index === task.attempts.length - 1 ? { ...attempt, outcome, note, finishedAt: now.toISOString() } : attempt,
  );
  return withStatus(task, to, now, { attempts });
}

/** Records the validation verdict on the last (already finished) attempt. */
function resolveLastAttempt(
  task: TaskRecord,
  outcome: 'overridden' | 'rejected' | 'review-rejected',
  note: string | null,
  now: Date,
  to: TaskStatus,
): TaskRecord {
  const attempts = task.attempts.map((attempt, index) =>
    index === task.attempts.length - 1 ? { ...attempt, outcome, note } : attempt,
  );
  return withStatus(task, to, now, { attempts });
}

function withLastAttempt(task: TaskRecord, changes: Partial<TaskAttempt>): TaskRecord {
  const attempts = task.attempts.map((attempt, index) => (index === task.attempts.length - 1 ? { ...attempt, ...changes } : attempt));
  return { ...task, attempts };
}

function bounded(note: string | null): string | null {
  return note === null ? null : note.length <= TASK_LIMITS.note ? note : `${note.slice(0, TASK_LIMITS.note - 1)}…`;
}

function replaceTask(state: ProjectState, task: TaskRecord): ProjectState {
  return { ...state, tasks: state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)) };
}

function findTask(state: ProjectState, taskId: string): TaskRecord {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  if (task === undefined) {
    throw new WorkflowError(`Unknown task "${taskId}"`);
  }
  return task;
}

function findMilestone(state: ProjectState, milestoneId: string): MilestoneRecord {
  const milestone = state.milestones.find((candidate) => candidate.id === milestoneId);
  if (milestone === undefined) {
    throw new WorkflowError(`Unknown milestone "${milestoneId}"`);
  }
  return milestone;
}

function explainNotRunnable(view: TaskView, state: ProjectState): string {
  const label = (id: string): string => {
    const dependency = state.tasks.find((task) => task.id === id);
    return dependency === undefined ? id : `"${dependency.title}"`;
  };
  switch (view.condition) {
    case 'waiting':
      return `waiting for ${view.unmetDependencies.map(label).join(', ')} to succeed`;
    case 'blocked':
      return `blocked because ${view.blockingDependencies.map(label).join(', ')} can no longer succeed`;
    case 'exhausted':
      return `all ${view.task.maxAttempts} attempts have been used`;
    case 'running':
      return 'it is already running';
    case 'interrupted':
      return 'its previous execution was interrupted; run `forge task recover` first';
    case 'awaiting-validation':
      return 'it is awaiting validation; accept or reject it';
    default:
      return `it is ${view.condition}`;
  }
}

function describeView(view: TaskView): string {
  return `${view.key} ${view.condition}`;
}

function requireText(value: string, label: string, max: number): string {
  const text = optionalText(value, label, max);
  if (text === null) {
    throw new WorkflowError(`${label} must not be empty`);
  }
  return text;
}

function optionalText(value: string | null | undefined, label: string, max: number): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value.includes('\0')) {
    throw new WorkflowError(`${label} must not contain NUL characters`);
  }
  const text = value.trim();
  if (text.length > max) {
    throw new WorkflowError(`${label} is too long (${text.length} characters; limit ${max})`);
  }
  return text === '' ? null : text;
}
