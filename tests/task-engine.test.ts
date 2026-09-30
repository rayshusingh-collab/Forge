import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { after, describe, it } from 'node:test';

import { StateConflictError, WorkflowError } from '../src/core/errors.ts';
import { openStateStore } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { createInitialState, findCycle, findDependencyProblem } from '../src/state/index.ts';
import type { WorkerRunRecord } from '../src/state/index.ts';
import {
  MILESTONE_TRANSITIONS,
  TASK_TRANSITIONS,
  TaskEngine,
  addMilestone,
  addTask,
  deriveWorkflow,
  resolveTaskReference,
  startAttempt,
} from '../src/tasks/index.ts';
import type { RunTaskOptions } from '../src/tasks/index.ts';
import type { WorkerRequest, WorkerResult } from '../src/workers/index.ts';
import { TempDirs } from './fixtures.ts';
import { FakeWorker, createTestProject } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

const NOW = new Date('2026-05-01T10:00:00.000Z');

interface Setup {
  readonly project: LoadedProject;
  readonly engine: TaskEngine;
}

async function setup(options: { liveness?: (executor: { pid: number; host: string }) => boolean } = {}): Promise<Setup> {
  const project = await createTestProject(temp);
  const evidenceDirectory = await temp.make('forge-evidence-');
  return {
    project,
    engine: new TaskEngine({ project, evidenceDirectory, ...(options.liveness === undefined ? {} : { liveness: options.liveness }) }),
  };
}

/** Milestone 1 with tasks A, and B depending on A. */
async function twoTasks(engine: TaskEngine) {
  await engine.addMilestone({ title: 'Foundation' });
  const a = await engine.addTask({ milestone: '1', title: 'Task A', instruction: 'Do A' });
  const b = await engine.addTask({ milestone: '1', title: 'Task B', instruction: 'Do B', dependsOn: [a.id] });
  return { a, b };
}

function worker(behave?: (request: WorkerRequest) => Promise<Partial<WorkerResult>>, options: { available?: boolean } = {}): FakeWorker {
  return new FakeWorker(behave, options);
}

function runOptions(fake: FakeWorker, extra: Partial<RunTaskOptions> = {}): RunTaskOptions {
  return { worker: fake, access: 'read-only', timeoutMs: 60_000, ...extra };
}

async function condition(engine: TaskEngine, reference: string): Promise<string> {
  const view = await engine.view();
  return view.task(resolveTaskReference(await engine.load(), reference))!.condition;
}

describe('milestones', () => {
  it('are created in order and listed deterministically', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'First' });
    await engine.addMilestone({ title: 'Second', description: 'More' });
    const view = await engine.view();
    assert.deepEqual(
      view.milestones.map((m) => [m.milestone.order, m.milestone.title, m.milestone.status]),
      [
        [1, 'First', 'pending'],
        [2, 'Second', 'pending'],
      ],
    );
  });

  it('become active when their first task starts and complete only when the rule holds', async () => {
    const { engine } = await setup();
    const { b } = await twoTasks(engine);
    await assert.rejects(engine.completeMilestone('1'), /cannot be completed: 2 task\(s\) are not finished/);

    await engine.runTask('1.1', runOptions(worker()));
    assert.equal((await engine.view()).milestones[0]!.milestone.status, 'active');
    await engine.overrideTask('1.1', 'reviewed');
    await assert.rejects(engine.completeMilestone('1'), /1 task\(s\) are not finished \(1\.2 ready\)/);

    await engine.cancelTask(b.id, 'not needed');
    await engine.completeMilestone('1');
    assert.equal((await engine.view()).milestones[0]!.milestone.status, 'completed');
  });

  it('reject impossible transitions', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'Empty' });
    await assert.rejects(engine.completeMilestone('1'), /no succeeded tasks/);
    await engine.cancelMilestone('1', null);
    await assert.rejects(engine.cancelMilestone('1', null), /Illegal milestone transition .* cancelled -> cancelled/);
    await assert.rejects(engine.addTask({ milestone: '1', title: 'x', instruction: 'y' }), /Cannot add tasks to cancelled milestone/);
    assert.deepEqual(MILESTONE_TRANSITIONS.completed, []);
    assert.deepEqual(MILESTONE_TRANSITIONS.cancelled, []);
  });

  it('cancel their unfinished tasks but refuse while work is awaiting validation', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await assert.rejects(engine.cancelMilestone('1', null), /running or awaiting validation/);
    await engine.rejectTask('1.1', 'wrong');
    await engine.cancelMilestone('1', 'scope change');
    const view = await engine.view();
    assert.equal(view.milestones[0]!.milestone.status, 'cancelled');
    assert.deepEqual(view.tasks.map((t) => [t.condition, t.task.cancelReason]), [
      ['cancelled', 'scope change'],
      ['cancelled', 'scope change'],
    ]);
  });
});

describe('tasks and dependencies', () => {
  it('are created in order with defaults', async () => {
    const { engine } = await setup();
    const { a, b } = await twoTasks(engine);
    assert.equal(a.order, 1);
    assert.equal(b.order, 2);
    assert.equal(a.maxAttempts, 3);
    assert.equal(a.status, 'pending');
    assert.deepEqual(b.dependsOn, [a.id]);
  });

  it('support multiple dependencies, including across milestones', async () => {
    const { engine } = await setup();
    const { a, b } = await twoTasks(engine);
    await engine.addMilestone({ title: 'Second' });
    const c = await engine.addTask({ milestone: '2', title: 'C', instruction: 'Do C', dependsOn: ['1.1', b.id] });
    assert.deepEqual(c.dependsOn, [a.id, b.id]);
    assert.equal(await condition(engine, '2.1'), 'waiting');
  });

  it('reject missing, duplicate, and cancelled dependencies', async () => {
    const { engine } = await setup();
    const { a, b } = await twoTasks(engine);
    await assert.rejects(engine.addTask({ milestone: '1', title: 'x', instruction: 'y', dependsOn: ['ffffffff'] }), /No task matches/);
    await assert.rejects(engine.addTask({ milestone: '1', title: 'x', instruction: 'y', dependsOn: [a.id, '1.1'] }), /more than once/);
    await engine.cancelTask(b.id, null);
    await assert.rejects(engine.addTask({ milestone: '1', title: 'x', instruction: 'y', dependsOn: [b.id] }), /cancelled task/);
  });

  it('reject a self-dependency and invalid attempt budgets', () => {
    const base = addMilestone(createInitialState('p', NOW), { id: 'm', title: 'M', description: null }, NOW);
    assert.throws(
      () => addTask(base, { id: 't', milestoneId: 'm', title: 'T', instruction: 'I', context: null, dependsOn: ['t'], maxAttempts: 3 }, NOW),
      /depends on itself/,
    );
    for (const maxAttempts of [0, 11, 1.5]) {
      assert.throws(
        () => addTask(base, { id: 't', milestoneId: 'm', title: 'T', instruction: 'I', context: null, dependsOn: [], maxAttempts }, NOW),
        /Maximum attempts/,
      );
    }
  });

  it('reject empty titles and instructions', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'M' });
    await assert.rejects(engine.addTask({ milestone: '1', title: '  ', instruction: 'y' }), /Task title must not be empty/);
    await assert.rejects(engine.addTask({ milestone: '1', title: 'x', instruction: '' }), /Task instruction must not be empty/);
    await assert.rejects(engine.addMilestone({ title: '' }), /Milestone title must not be empty/);
  });
});

describe('cycle detection', () => {
  const node = (id: string, ...dependsOn: string[]) => ({ id, dependsOn });

  it('finds no cycle in a DAG', () => {
    assert.equal(findCycle([node('a'), node('b', 'a'), node('c', 'a', 'b'), node('d', 'c')]), null);
  });

  it('finds direct, indirect, and self cycles deterministically', () => {
    assert.deepEqual(findCycle([node('a', 'b'), node('b', 'a')]), ['a', 'b', 'a']);
    assert.deepEqual(findCycle([node('a', 'b'), node('b', 'c'), node('c', 'a'), node('d', 'a')]), ['a', 'b', 'c', 'a']);
    assert.deepEqual(findCycle([node('x'), node('y', 'y')]), ['y', 'y']);
  });

  it('reports the first problem in a graph', () => {
    assert.deepEqual(findDependencyProblem([node('a', 'a')]), { kind: 'self', taskId: 'a' });
    assert.deepEqual(findDependencyProblem([node('a', 'z')]), { kind: 'missing', taskId: 'a', dependencyId: 'z' });
    assert.equal(findDependencyProblem([node('a'), node('b', 'a', 'a')])?.kind, 'duplicate');
    assert.equal(findDependencyProblem([node('a', 'b'), node('b', 'a')])?.kind, 'cycle');
  });
});

describe('runnability', () => {
  it('is ready without dependencies and waiting on unmet ones', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const view = await engine.view();
    assert.deepEqual(view.tasks.map((t) => t.condition), ['ready', 'waiting']);
    assert.deepEqual(view.runnable.map((t) => t.key), ['1.1']);
  });

  it('becomes ready when dependencies succeed', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    assert.equal(await condition(engine, '1.2'), 'waiting', 'awaiting validation is not success');
    await engine.overrideTask('1.1', 'reviewed');
    assert.equal(await condition(engine, '1.2'), 'ready');
  });

  it('keeps waiting while a dependency is retryable, and blocks when it is exhausted', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'M' });
    const a = await engine.addTask({ milestone: '1', title: 'A', instruction: 'A', maxAttempts: 1 });
    await engine.addTask({ milestone: '1', title: 'B', instruction: 'B', dependsOn: [a.id] });
    await engine.addTask({ milestone: '1', title: 'C', instruction: 'C', dependsOn: ['1.2'] });
    await engine.runTask('1.1', runOptions(worker(async () => ({ outcome: 'failed', summary: null }))));
    const view = await engine.view();
    assert.deepEqual(view.tasks.map((t) => t.condition), ['exhausted', 'blocked', 'blocked'], 'blocking is transitive');
    assert.deepEqual(view.task(view.tasks[1]!.task.id)!.blockingDependencies, [a.id]);
  });

  it('blocks dependents of a cancelled task', async () => {
    const { engine } = await setup();
    const { a } = await twoTasks(engine);
    await engine.cancelTask(a.id, null);
    assert.equal(await condition(engine, '1.2'), 'blocked');
    await assert.rejects(engine.runTask('1.2', runOptions(worker())), /blocked because "Task A" can no longer succeed/);
  });

  it('orders tasks by milestone order, then task order, regardless of creation order', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'One' });
    await engine.addMilestone({ title: 'Two' });
    await engine.addTask({ milestone: '2', title: 'two-a', instruction: 'x' });
    await engine.addTask({ milestone: '1', title: 'one-a', instruction: 'x' });
    await engine.addTask({ milestone: '2', title: 'two-b', instruction: 'x' });
    await engine.addTask({ milestone: '1', title: 'one-b', instruction: 'x' });
    const first = await engine.view();
    const second = await engine.view();
    assert.deepEqual(first.runnable.map((t) => `${t.key} ${t.task.title}`), ['1.1 one-a', '1.2 one-b', '2.1 two-a', '2.2 two-b']);
    assert.deepEqual(second.runnable.map((t) => t.task.id), first.runnable.map((t) => t.task.id));
  });

  it('documents the legal task transitions', () => {
    assert.deepEqual(TASK_TRANSITIONS, {
      pending: ['running', 'cancelled'],
      running: ['succeeded', 'awaiting-validation', 'failed'],
      'awaiting-validation': ['succeeded', 'failed'],
      failed: ['running', 'cancelled'],
      succeeded: [],
      cancelled: [],
    });
  });
});

describe('execution', () => {
  it('runs a runnable task once, links the attempt to its worker run, and stops', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const fake = worker(async () => ({ summary: 'Did A.' }));

    const outcome = await engine.runTask('1.1', runOptions(fake));

    assert.equal(outcome.run.status, 'success');
    assert.equal(outcome.attempt, 1);
    assert.equal(outcome.task?.condition, 'awaiting-validation');
    assert.equal(fake.requests.length, 1, 'exactly one worker invocation');
    assert.equal(fake.requests[0]!.task, 'Do A');

    const state = await engine.load();
    const task = state.tasks.find((t) => t.title === 'Task A')!;
    const run = state.workerRuns.find((r) => r.id === task.attempts[0]!.runId)!;
    assert.deepEqual([run.trigger, run.taskId, run.attempt, run.status], ['task', task.id, 1, 'success']);
    assert.equal(task.attempts[0]!.outcome, 'awaiting-validation');
    assert.equal(state.tasks.find((t) => t.title === 'Task B')!.attempts.length, 0, 'the dependent task was not run');
  });

  it('refuses a task that is not runnable without invoking the worker', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const fake = worker();
    await assert.rejects(engine.runTask('1.2', runOptions(fake)), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /waiting for "Task A" to succeed/);
      return true;
    });
    assert.equal(fake.requests.length, 0);
  });

  const failures: readonly (readonly [string, Partial<WorkerResult>, string])[] = [
    ['worker failure', { outcome: 'failed', summary: null, diagnostics: ['boom'] }, 'failed'],
    ['timeout', { outcome: 'timeout', summary: null }, 'timeout'],
    ['invalid output', { outcome: 'invalid-output', summary: null }, 'invalid-output'],
    ['unavailable during execution', { outcome: 'unavailable', summary: null }, 'unavailable'],
  ];
  for (const [label, result, outcome] of failures) {
    it(`maps ${label} to a failed, retryable attempt`, async () => {
      const { engine } = await setup();
      await twoTasks(engine);
      const run = await engine.runTask('1.1', runOptions(worker(async () => result)));
      assert.equal(run.task?.condition, 'retryable');
      assert.equal(run.task?.task.status, 'failed');
      assert.equal(run.task?.lastAttempt?.outcome, outcome);
      assert.equal(run.task?.attemptsRemaining, 2);
    });
  }

  it('maps a cancelled execution to a failed attempt, leaving nothing running', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const controller = new AbortController();
    const fake = worker(async () => {
      controller.abort();
      return { outcome: 'cancelled', summary: null };
    });
    const run = await engine.runTask('1.1', runOptions(fake, { signal: controller.signal }));
    assert.equal(run.task?.task.status, 'failed');
    assert.equal(run.task?.lastAttempt?.outcome, 'cancelled');
    assert.equal(run.task?.condition, 'retryable');
  });

  it('does not record an attempt when the worker is unavailable before starting', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const fake = worker(undefined, { available: false });
    await assert.rejects(engine.runTask('1.1', runOptions(fake)), /not available .* no attempt was recorded/);
    assert.equal(fake.requests.length, 0);
    const view = await engine.view();
    assert.equal(view.tasks[0]!.attemptsUsed, 0);
    assert.equal(view.tasks[0]!.condition, 'ready');
  });

  it('counts attempts, allows explicit retries, and stops at the maximum', async () => {
    const { engine } = await setup();
    await engine.addMilestone({ title: 'M' });
    await engine.addTask({ milestone: '1', title: 'Flaky', instruction: 'x', maxAttempts: 2 });
    const failing = worker(async () => ({ outcome: 'failed', summary: null }));

    const first = await engine.runTask('1.1', runOptions(failing));
    assert.deepEqual([first.attempt, first.task?.condition], [1, 'retryable']);
    const second = await engine.runTask('1.1', runOptions(failing));
    assert.deepEqual([second.attempt, second.task?.condition], [2, 'exhausted']);
    await assert.rejects(engine.runTask('1.1', runOptions(failing)), /all 2 attempts have been used/);
    assert.equal(failing.requests.length, 2, 'no automatic retries, and none beyond the budget');
  });

  it('refuses to start the same task twice concurrently', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = worker(async () => {
      await gate;
      return {};
    });

    const first = engine.runTask('1.1', runOptions(slow));
    // Wait until the first execution is recorded as running.
    while ((await engine.view()).tasks[0]!.condition !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const other = new TaskEngine({ project: (engine as unknown as { project: LoadedProject }).project });
    await assert.rejects(other.runTask('1.1', runOptions(worker())), /already running/);
    release();
    assert.equal((await first).task?.condition, 'awaiting-validation');
    assert.equal(slow.requests.length, 1);
  });

  it('refuses a concurrent start while an edit-enabled run holds the state lease', async () => {
    const { project, engine } = await setup();
    await twoTasks(engine);
    await engine.addTask({ milestone: '1', title: 'Independent', instruction: 'x' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = engine.runTask('1.1', runOptions(worker(async () => { await gate; return {}; }), { access: 'edit' }));
    while ((await engine.view()).tasks[0]!.condition !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const other = new TaskEngine({ project, store: openStateStore(project, { lockTimeoutMs: 200 }) });
    await assert.rejects(other.runTask('1.3', runOptions(worker())), StateConflictError);
    release();
    await first;
    // Once the lease is released, the independent task can run.
    assert.equal((await other.runTask('1.3', runOptions(worker()))).task?.condition, 'awaiting-validation');
  });

  it('records an integrity violation as a failed attempt that needs acknowledgement to retry', async () => {
    const { project, engine } = await setup();
    await twoTasks(engine);
    const tamper = worker(async () => {
      await writeFile(project.layout.gitignoreFile, '');
      return { outcome: 'success', summary: 'All good' };
    });
    const run = await engine.runTask('1.1', runOptions(tamper, { access: 'edit' }));
    assert.equal(run.run.status, 'integrity-violation');
    assert.equal(run.task?.task.status, 'failed');
    assert.equal(run.task?.lastAttempt?.outcome, 'integrity-violation');
    assert.equal(run.task?.requiresIntegrityAcknowledgement, true);

    await assert.rejects(engine.runTask('1.1', runOptions(worker())), /--acknowledge-integrity-violation/);
    const retry = await engine.runTask('1.1', runOptions(worker(), { acknowledgeIntegrityViolation: true }));
    assert.equal(retry.task?.condition, 'awaiting-validation');
  });

  it('fails closed when a worker tampers with state: the task stays running until recovered', async () => {
    const { project, engine } = await setup({ liveness: () => false });
    await twoTasks(engine);
    const tamper = worker(async () => {
      const raw = JSON.parse(await readFile(project.layout.stateFile, 'utf8'));
      await writeFile(project.layout.stateFile, JSON.stringify({ ...raw, phase: 'completed' }, null, 2));
      return { outcome: 'success' };
    });
    const run = await engine.runTask('1.1', runOptions(tamper, { access: 'edit' }));
    assert.equal(run.run.status, 'integrity-violation');
    assert.ok(run.run.persistenceError, 'outcome was not written through tampered state');
    // The attempt stays recorded as running and surfaces as interrupted for an explicit decision.
    const view = await engine.view();
    assert.equal(view.tasks[0]!.task.status, 'running');
    assert.equal(view.tasks[0]!.condition, 'interrupted');
    await engine.recoverTask('1.1', { force: false });
    assert.equal((await engine.view()).tasks[0]!.lastAttempt?.outcome, 'interrupted');
  });
});

describe('manual validation', () => {
  it('accepts a task awaiting validation and unblocks its dependents', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await engine.overrideTask('1.1', 'looks right');
    const view = await engine.view();
    assert.equal(view.tasks[0]!.condition, 'succeeded');
    assert.equal(view.tasks[0]!.lastAttempt?.outcome, 'overridden');
    assert.equal(view.tasks[0]!.lastAttempt?.note, 'override: looks right');
    assert.deepEqual(view.runnable.map((t) => t.key), ['1.2']);
  });

  it('rejects a task awaiting validation, consuming the attempt', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await engine.rejectTask('1.1', 'missed the edge case');
    const task = (await engine.view()).tasks[0]!;
    assert.deepEqual([task.task.status, task.condition, task.attemptsRemaining], ['failed', 'retryable', 2]);
    assert.equal(task.lastAttempt?.outcome, 'rejected');
    assert.equal(task.lastAttempt?.note, 'missed the edge case');
  });

  it('cannot accept a task that never ran successfully', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await assert.rejects(engine.overrideTask('1.1', 'reviewed'), /is pending; only a task awaiting validation/);
    await engine.runTask('1.1', runOptions(worker(async () => ({ outcome: 'failed', summary: null }))));
    await assert.rejects(engine.overrideTask('1.1', 'reviewed'), /is failed; only a task awaiting validation/);
    await assert.rejects(engine.rejectTask('1.2', 'x'), /is pending/);
  });

  it('requires a rejection reason', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await assert.rejects(engine.rejectTask('1.1', '  '), /Rejection reason must not be empty/);
  });

  it('never resurrects terminal tasks', async () => {
    const { engine } = await setup();
    const { b } = await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await engine.overrideTask('1.1', 'reviewed');
    await assert.rejects(engine.runTask('1.1', runOptions(worker())), /not runnable: it is succeeded/);
    await assert.rejects(engine.cancelTask('1.1', null), /succeeded -> cancelled/);
    await engine.cancelTask(b.id, null);
    await assert.rejects(engine.runTask(b.id, runOptions(worker())), /not runnable: it is cancelled/);
    await assert.rejects(engine.overrideTask(b.id, 'reviewed'), /is cancelled/);
  });
});

describe('crash recovery', () => {
  /** Records a running attempt whose Forge process has exited, as after a crash. */
  async function crashedExecution(project: LoadedProject): Promise<number> {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    const store = openStateStore(project);
    await store.update((state) => {
      const task = state.tasks[0]!;
      const run: WorkerRunRecord = {
        id: 'crashed-run',
        worker: 'claude-code',
        trigger: 'task',
        access: 'edit',
        taskId: task.id,
        attempt: 1,
        task: task.instruction,
        workingDirectory: '.',
        status: 'running',
        startedAt: NOW.toISOString(),
        finishedAt: null,
        durationMs: null,
        summary: null,
        diagnostic: null,
      };
      return startAttempt(
        { ...state, workerRuns: [...state.workerRuns, run] },
        {
          taskId: task.id,
          runId: run.id,
          attemptNumber: 1,
          executor: { pid: dead, host: hostname() },
          acknowledgeIntegrityViolation: false,
          liveness: () => true,
        },
        NOW,
      );
    });
    return dead;
  }

  it('detects an interrupted execution and never reruns it automatically', async () => {
    const { project, engine } = await setup();
    await twoTasks(engine);
    await crashedExecution(project);

    const view = await engine.view();
    assert.equal(view.tasks[0]!.condition, 'interrupted');
    assert.deepEqual(view.runnable, []);
    const fake = worker();
    await assert.rejects(engine.runTask('1.1', runOptions(fake)), /was interrupted; run `forge task recover` first/);
    assert.equal(fake.requests.length, 0);
  });

  it('recovers explicitly to a failed, retryable attempt without inferring success', async () => {
    const { project, engine } = await setup();
    await twoTasks(engine);
    await crashedExecution(project);

    await engine.recoverTask('1.1', { force: false });

    const state = await engine.load();
    const task = state.tasks[0]!;
    assert.equal(task.status, 'failed');
    assert.equal(task.attempts[0]!.outcome, 'interrupted');
    assert.equal(state.workerRuns.find((r) => r.id === 'crashed-run')?.status, 'interrupted');
    assert.equal((await engine.view()).tasks[0]!.condition, 'retryable');
    assert.equal((await engine.runTask('1.1', runOptions(worker()))).attempt, 2);
  });

  it('refuses to recover an execution that is still alive unless forced', async () => {
    const { project } = await setup();
    const alive = new TaskEngine({ project, liveness: () => true });
    await twoTasks(alive);
    await crashedExecution(project);
    assert.equal((await alive.view()).tasks[0]!.condition, 'running');
    await assert.rejects(alive.recoverTask('1.1', { force: false }), /still be running/);
    await alive.recoverTask('1.1', { force: true });
    assert.equal((await alive.view()).tasks[0]!.condition, 'retryable');
  });

  it('refuses to recover a task that is not running', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    await assert.rejects(engine.recoverTask('1.1', { force: true }), /is pending; only an interrupted running task/);
  });
});

describe('state', () => {
  it('survives a fresh engine and store (restart)', async () => {
    const { project, engine } = await setup();
    await twoTasks(engine);
    await engine.runTask('1.1', runOptions(worker()));
    await engine.overrideTask('1.1', 'reviewed');

    const restarted = new TaskEngine({ project });
    const view = await restarted.view();
    assert.deepEqual(view.tasks.map((t) => [t.key, t.condition]), [
      ['1.1', 'succeeded'],
      ['1.2', 'ready'],
    ]);
  });

  it('serializes concurrent additions without losing any', async () => {
    const { project, engine } = await setup();
    await engine.addMilestone({ title: 'M' });
    const engines = Array.from({ length: 5 }, () => new TaskEngine({ project }));
    await Promise.all(engines.map((e, index) => e.addTask({ milestone: '1', title: `T${index}`, instruction: 'x' })));
    const tasks = (await engine.view()).tasks;
    assert.equal(tasks.length, 5);
    assert.deepEqual(tasks.map((t) => t.task.order), [1, 2, 3, 4, 5]);
  });

  it('never persists an invalid transition', async () => {
    const { engine, project } = await setup();
    await twoTasks(engine);
    const before = await openStateStore(project).load();
    await assert.rejects(engine.overrideTask('1.2', 'reviewed'));
    assert.equal((await openStateStore(project).load()).revision, before.revision);
  });

  it('derives views purely from state', async () => {
    const { engine } = await setup();
    await twoTasks(engine);
    const state = await engine.load();
    assert.deepEqual(
      deriveWorkflow(state, () => true).tasks.map((t) => t.condition),
      deriveWorkflow(state, () => true).tasks.map((t) => t.condition),
    );
  });
});

describe('references', () => {
  it('resolves keys, full IDs, and unique prefixes, and refuses ambiguity', async () => {
    const project = await createTestProject(temp);
    const ids = ['abcd1111-0000-4000-8000-000000000001', 'abcd2222-0000-4000-8000-000000000002', 'ffff0000-0000-4000-8000-000000000003'];
    const queue = ['m0000000-0000-4000-8000-000000000000', ...ids];
    const engine = new TaskEngine({ project, generateId: () => queue.shift()! });
    await engine.addMilestone({ title: 'M' });
    for (const title of ['one', 'two', 'three']) {
      await engine.addTask({ milestone: '1', title, instruction: 'x' });
    }
    const state = await engine.load();
    assert.equal(resolveTaskReference(state, '1.2'), ids[1]);
    assert.equal(resolveTaskReference(state, ids[2]!), ids[2]);
    assert.equal(resolveTaskReference(state, 'ffff'), ids[2]);
    assert.equal(resolveTaskReference(state, 'ABCD1'), ids[0]);
    assert.throws(() => resolveTaskReference(state, 'abcd'), /ambiguous; it matches tasks abcd1111, abcd2222/);
    assert.throws(() => resolveTaskReference(state, 'abc'), /too short/);
    assert.throws(() => resolveTaskReference(state, '1.9'), /No task 1\.9/);
    assert.throws(() => resolveTaskReference(state, '9999'), /No task matches/);
  });
});
