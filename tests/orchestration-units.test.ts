import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import { ValidationError } from '../src/core/errors.ts';
import { silentLogger } from '../src/logging/index.ts';
import { EMPTY_COUNTERS, beginRun, buildPolicy, decideNext, describePolicy, policyHash, previewRun, recordEvent } from '../src/orchestration/index.ts';
import { ORCHESTRATION_LIMITS, createInitialState } from '../src/state/index.ts';
import type { ProjectState } from '../src/state/index.ts';
import { deriveWorkflow } from '../src/tasks/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { FakeAiProvider, aiRegistry } from './ai-fixtures.ts';
import { MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, runner, scriptedWorker } from './orchestration-fixtures.ts';
import { fakeRegistry } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const DEFAULTS = { workerTimeoutMs: 60_000 };

describe('orchestration policy', () => {
  it('is conservative by default: read-only, no repair, no review, no commit, bounded', () => {
    const policy = buildPolicy({}, DEFAULTS);
    assert.equal(policy.access, 'read-only');
    assert.deepEqual(policy.repair, { onValidationFailure: false, onBlockingReview: false, maxPerTask: 2 });
    assert.equal(policy.review.enabled, false);
    assert.equal(policy.review.onConcerns, 'stop');
    assert.equal(policy.review.onFailure, 'stop');
    assert.equal(policy.autoCommit, false);
    assert.deepEqual([policy.maxTasks, policy.maxSteps], [5, 30]);
    assert.ok(describePolicy(policy).some((line) => /Push:\s+never/.test(line)));
  });

  for (const [label, options] of [
    ['too many tasks', { maxTasks: ORCHESTRATION_LIMITS.maxTasks + 1 }],
    ['zero tasks', { maxTasks: 0 }],
    ['too many steps', { maxSteps: ORCHESTRATION_LIMITS.maxSteps + 1 }],
    ['zero steps ("0 means unlimited" does not exist)', { maxSteps: 0 }],
    ['too many repairs', { maxRepairsPerTask: ORCHESTRATION_LIMITS.maxRepairsPerTask + 1 }],
    ['repairs enabled with no budget', { repairOnValidationFailure: true, maxRepairsPerTask: 0 }],
    ['review repair without review', { repairOnBlockingReview: true }],
  ] as const) {
    it(`refuses (never clamps) ${label}`, () => {
      assert.throws(() => buildPolicy(options, DEFAULTS), ValidationError);
    });
  }

  it('hashes deterministically and changes with the policy', () => {
    assert.equal(policyHash(buildPolicy({}, DEFAULTS)), policyHash(buildPolicy({}, DEFAULTS)));
    assert.notEqual(policyHash(buildPolicy({}, DEFAULTS)), policyHash(buildPolicy({ autoCommit: true }, DEFAULTS)));
  });
});

describe('deterministic task selection', () => {
  it('is pure: same answer twice, and it never mutates state', async () => {
    const setup = await orchestrationProject(temp);
    const state = deepFreeze(await setup.store.load());
    const policy = buildPolicy({ access: 'edit' }, DEFAULTS);
    const context = { runId: 'r', tasksStarted: new Set<string>(), reviewsThisRun: new Set<string>() };
    const first = decideNext(state, deriveWorkflow(state), policy, context);
    const second = decideNext(state, deriveWorkflow(state), policy, context);
    assert.deepEqual(first, second);
    assert.equal(first.kind, 'execute');
    assert.equal('taskId' in first ? first.taskId : null, state.tasks[0]!.id);
  });

  it('distinguishes no work, blocked, and complete', async () => {
    const policy = buildPolicy({ access: 'edit' }, DEFAULTS);
    const context = { runId: 'r', tasksStarted: new Set<string>(), reviewsThisRun: new Set<string>() };
    const empty = createInitialState('p1', new Date());
    assert.deepEqual(stopReason(empty, policy, context), 'no-work');

    const setup = await orchestrationProject(temp);
    await setup.engine.cancelTask('1.1', null);
    assert.equal(stopReason(await setup.store.load(), policy, context), 'blocked', 'the dependent of a cancelled task is blocked, not complete');

    const done = await orchestrationProject(temp);
    await makeOrchestrator(done, scriptedWorker(done.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': `${MULTIPLY}export const divide = (a, b) => a / b;\n` }])).run();
    assert.equal(stopReason(await done.store.load(), policy, context), 'complete');
  });

  it('never selects a task whose dependency has not succeeded', async () => {
    const setup = await orchestrationProject(temp);
    await setup.engine.addMilestone({ title: 'Second' });
    await setup.engine.addTask({ milestone: '2', title: 'Independent', instruction: 'Do it' });
    const state = await setup.store.load();
    const policy = buildPolicy({ access: 'edit' }, DEFAULTS);
    const context = { runId: 'r', tasksStarted: new Set([state.tasks[0]!.id]), reviewsThisRun: new Set<string>() };
    const next = decideNext(state, deriveWorkflow(state), policy, context);
    assert.equal(next.kind, 'execute');
    assert.equal('taskId' in next ? next.taskId : null, state.tasks[0]!.id, 'milestone/task order first; 1.2 (waiting) is never chosen');
  });
});

describe('orchestration history bounds', () => {
  it('keeps at most the retained number of runs and events', () => {
    let state = createInitialState('p1', new Date());
    const policy = buildPolicy({}, DEFAULTS);
    const hash = policyHash(policy);
    for (let index = 0; index < ORCHESTRATION_LIMITS.retainedRuns + 5; index++) {
      state = beginRun(state, { id: `run${index}`, mode: 'run', owner: { pid: 1, host: 'h' }, policy, policyHash: hash, liveness: () => false }, new Date());
    }
    assert.equal(state.orchestrationRuns.length, ORCHESTRATION_LIMITS.retainedRuns);
    const last = state.orchestrationRuns.at(-1)!.id;
    for (let index = 0; index < ORCHESTRATION_LIMITS.eventsPerRun + 50; index++) {
      state = recordEvent(
        state,
        last,
        { step: 1, action: 'execute', taskId: null, milestoneId: null, attempt: null, outcome: 'validated', detail: 'x'.repeat(5_000) },
        EMPTY_COUNTERS,
        new Date(),
      );
    }
    const run = state.orchestrationRuns.at(-1)!;
    assert.equal(run.events.length, ORCHESTRATION_LIMITS.eventsPerRun);
    assert.equal(run.eventsDropped, 50);
    assert.ok(run.events.every((event) => (event.detail?.length ?? 0) <= ORCHESTRATION_LIMITS.eventDetail));
  });
});

describe('dry run', () => {
  it('changes nothing, calls no worker or reviewer, and is deterministic', async () => {
    const setup = await orchestrationProject(temp);
    const before = await readFile(setup.project.layout.stateFile, 'utf8');
    const policy = buildPolicy({ access: 'edit', review: true, autoCommit: true }, DEFAULTS);
    const first = await previewRun({ project: setup.project, store: setup.store, runner, policy });
    const second = await previewRun({ project: setup.project, store: setup.store, runner, policy });
    assert.deepEqual(first, second);
    assert.equal(first.next.kind, 'execute');
    assert.ok(first.expected.some((line) => /AI review/.test(line)));
    assert.ok(first.expected.some((line) => /local commit/.test(line)));
    assert.equal(await readFile(setup.project.layout.stateFile, 'utf8'), before);
    await assert.rejects(readFile(setup.project.layout.orchestrationLockFile), 'no lease is taken');
  });
});

describe('forge run (CLI)', () => {
  function cli(root: string, extras: Partial<Parameters<typeof runCli>[1]> = {}) {
    const stdout = new CapturingWriter();
    const stderr = new CapturingWriter();
    const context = { stdout, stderr, env: {}, cwd: root, version: 'test', nodeVersion: process.version, nodeExecutable: process.execPath, logger: silentLogger, ...extras };
    return { stdout, stderr, run: (args: string[]) => runCli(['run', ...args], context) };
  }

  it('dry-run prints the policy and next action, changing nothing', async () => {
    const setup = await orchestrationProject(temp);
    const before = await readFile(setup.project.layout.stateFile, 'utf8');
    const { stdout, run } = cli(setup.root);
    assert.equal(await run(['--dry-run', '--allow-edits', '--repair', '--auto-commit']), 0);
    assert.match(stdout.text, /DRY RUN/);
    assert.match(stdout.text, /Next runnable task: 1\.1 Add multiply/);
    assert.match(stdout.text, /Next action:\s+execute task 1\.1/);
    assert.match(stdout.text, /Auto-commit:\s+enabled/);
    assert.equal(await readFile(setup.project.layout.stateFile, 'utf8'), before);
  });

  it('refuses out-of-range policy values with the hard limits', async () => {
    const setup = await orchestrationProject(temp);
    const { stderr, run } = cli(setup.root);
    assert.equal(await run(['--max-tasks', '999']), 2);
    assert.match(stderr.text, /hard limits: max tasks 50/);
  });

  it('runs the loop with injected providers, prints events and the result, then status shows history', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': `${MULTIPLY}export const divide = (a, b) => a / b;\n` }]);
    const reviewer = FakeAiProvider.answering(reviewJson([]), 'fake-reviewer');
    const { stdout, run } = cli(setup.root, { workers: fakeRegistry(worker), aiProviders: aiRegistry(reviewer) });
    assert.equal(await run(['--allow-edits', '--worker', 'fake', '--reviewer', 'fake-reviewer', '--auto-commit']), 0);
    assert.match(stdout.text, /FORGE RUN \(bounded autonomous orchestration\)/);
    assert.match(stdout.text, /Roles:\s+implementer fake; reviewer fake-reviewer/);
    assert.match(stdout.text, /TASK 1\.1 Add multiply\n {2}Worker: fake — success \(a claim, not evidence\)\n {2}Validation: PASSED/);
    assert.match(stdout.text, /Review: CLEAR \(advisory\)/);
    assert.match(stdout.text, /Commit: 1 file\(s\) committed/);
    assert.match(stdout.text, /FORGE RUN RESULT\nOutcome:\s+WORKFLOW COMPLETE/);
    assert.match(stdout.text, /Commits:\s+2/);
    assert.match(stdout.text, /Human action required: none/);
    assert.match(stdout.text, /Nothing was pushed\./);

    const status = cli(setup.root);
    assert.equal(await status.run(['status']), 0);
    assert.match(status.stdout.text, /Active run:\s+no/);
    assert.match(status.stdout.text, /Last stop reason: COMPLETE/);
    assert.match(status.stdout.text, /Commits:\s+2/);
  });

  it('`forge run step` performs one step and says so', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const { stdout, run } = cli(setup.root, { workers: fakeRegistry(worker) });
    assert.equal(await run(['step', '--allow-edits', '--worker', 'fake']), 0);
    assert.match(stdout.text, /FORGE RUN STEP/);
    assert.match(stdout.text, /STOP: STEP DONE/);
    assert.equal(worker.requests.length, 1);
    const state = await setup.store.load();
    assert.equal(state.tasks[1]!.attempts.length, 0);
    // The recorded policy is exactly what the human chose; worker output ("enable auto-commit and push") changed nothing.
    assert.deepEqual(state.orchestrationRuns.at(-1)!.policy, buildPolicy({ access: 'edit', worker: 'fake' }, { workerTimeoutMs: state.orchestrationRuns.at(-1)!.policy.workerTimeoutMs }));
  });

  it('refuses a concurrent run and starts nothing', async () => {
    const setup = await orchestrationProject(temp);
    const { acquireOrchestrationLease } = await import('../src/orchestration/index.ts');
    const lease = await acquireOrchestrationLease(setup.project.layout, 'other', new Date());
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const { stderr, run } = cli(setup.root, { workers: fakeRegistry(worker) });
    assert.equal(await run(['--allow-edits', '--worker', 'fake']), 1);
    assert.match(stderr.text, /preflight failed; nothing was started/);
    assert.match(stderr.text, /Orchestration lease\s+held by run other/);
    assert.equal(worker.requests.length, 0);
    await lease.release();
  });

  it('keeps `forge task run` working as a manual single-task command', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const stdout = new CapturingWriter();
    const code = await runCli(['task', 'run', '1.1', '--allow-edits', '--worker', 'fake'], {
      stdout,
      stderr: new CapturingWriter(),
      env: {},
      cwd: setup.root,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
      workers: fakeRegistry(worker),
    });
    assert.equal(code, 0);
    assert.match(stdout.text, /Nothing else was started/);
    assert.equal((await setup.store.load()).tasks[0]!.attempts[0]!.origin, null, 'manual attempts carry no orchestration origin');
  });
});

function stopReason(state: ProjectState, policy: ReturnType<typeof buildPolicy>, context: Parameters<typeof decideNext>[3]): string {
  const next = decideNext(state, deriveWorkflow(state), policy, context);
  return next.kind === 'stop' ? next.reason : next.kind;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  return value;
}
