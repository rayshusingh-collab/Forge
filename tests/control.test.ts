import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveApproval } from '../src/approvals/index.ts';
import { ProjectConfigStore, effectiveSettings } from '../src/config/index.ts';
import { deriveAudit, explain, pauseProject, resumeProject, runPreflight } from '../src/control/index.ts';
import { ProjectConfigError, ValidationError } from '../src/core/errors.ts';
import { acquireOrchestrationLease, buildPolicy, recoverOrchestrationLease, resolvePolicy } from '../src/orchestration/index.ts';
import { deriveWorkflow } from '../src/tasks/index.ts';
import { TempDirs } from './fixtures.ts';
import { FakeAiProvider, aiRegistry } from './ai-fixtures.ts';
import { git, write } from './git-fixtures.ts';
import { DIVIDE, MULTIPLY, makeOrchestrator, orchestrationProject, runner, scriptedWorker } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';
import { FakeWorker, fakeRegistry } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const DEFAULTS = { workerTimeoutMs: 60_000 };

const pause = (setup: OrchestrationSetup, reason = 'lunch') => setup.store.update((state) => pauseProject(state, reason, `p${Date.now()}`, new Date()));

describe('pause and resume', () => {
  it('a paused project refuses autonomous runs, worker runs, validation, and commits', async () => {
    const setup = await orchestrationProject(temp);
    await pause(setup, 'Reviewing the plan');
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const result = await makeOrchestrator(setup, worker).run();
    assert.equal(result.stop.reason, 'paused');
    assert.match(result.stop.detail ?? '', /Reviewing the plan/);
    assert.equal(worker.requests.length, 0);
    await assert.rejects(setup.engine.runTask('1.1', { worker, access: 'edit', timeoutMs: 60_000 }), /paused/);
    assert.equal(worker.requests.length, 0);
    // Inspection still works.
    assert.equal((await setup.engine.view()).tasks.length, 2);
  });

  it('records who/why/when, needs an explicit resume with a reason, and resuming starts nothing', async () => {
    const setup = await orchestrationProject(temp);
    await pause(setup, 'Holiday');
    await assert.rejects(pause(setup, 'again'), /already paused/);
    let state = await setup.store.load();
    assert.deepEqual([state.pause?.reason, state.pause?.by], ['Holiday', 'human']);
    assert.throws(() => resumeProject(state, '', 'r1', new Date()), /reason/);
    state = await setup.store.update((current) => resumeProject(current, 'Back', 'r1', new Date()));
    assert.equal(state.pause, null);
    assert.deepEqual(state.controlEvents.map((event) => [event.kind, event.reason, event.by]), [['paused', 'Holiday', 'human'], ['resumed', 'Back', 'human']]);
    assert.equal(state.tasks[0]!.attempts.length, 0);
  });

  it('takes effect before the next orchestration step, without interrupting the running one', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]);
    // Another terminal pauses while the first task is executing; the orchestrator sees it before its next step.
    const result = await makeOrchestrator(setup, worker, {}, { reporter: { onStep: async () => void (await pause(setup, 'stop after this')) } }).run();
    assert.equal(result.stop.reason, 'paused');
    assert.equal(worker.requests.length, 1, 'the first task finished normally; the second never started');
    assert.equal((await setup.store.load()).tasks[0]!.status, 'succeeded');
  });
});

describe('orchestration lease recovery', () => {
  async function staleLease(setup: OrchestrationSetup, owner: { pid: number; host: string; runId?: string }): Promise<string> {
    const runId = owner.runId ?? 'crashed-run';
    const content = JSON.stringify({ runId, pid: owner.pid, host: owner.host, acquiredAt: new Date().toISOString(), token: 'abc123' });
    await writeFile(setup.project.layout.orchestrationLockFile, content);
    return content;
  }
  async function crashedRunRecord(setup: OrchestrationSetup): Promise<string> {
    await makeOrchestrator(setup, scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]), { maxSteps: 1 }).run();
    const state = await setup.store.update((current) => ({
      ...current,
      orchestrationRuns: current.orchestrationRuns.map((run) => ({ ...run, status: 'running', finishedAt: null, stop: null, owner: { pid: 999_999_999, host: hostname() } })),
    }));
    return state.orchestrationRuns[0]!.id;
  }

  it('recovers a lease whose local owner is provably dead, marks the run interrupted, and re-runs nothing', async () => {
    const setup = await orchestrationProject(temp);
    const runId = await crashedRunRecord(setup);
    await staleLease(setup, { pid: 999_999_999, host: hostname(), runId });
    const before = await setup.store.load();
    const result = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'crashed laptop', force: false });
    assert.equal(result.kind, 'recovered');
    assert.equal(result.kind === 'recovered' && result.runMarkedInterrupted, true);
    await assert.rejects(readFile(setup.project.layout.orchestrationLockFile));
    const after = await setup.store.load();
    assert.equal(after.orchestrationRuns[0]!.status, 'interrupted');
    assert.deepEqual(after.tasks.map((task) => task.attempts.length), before.tasks.map((task) => task.attempts.length));
    assert.equal(after.controlEvents.at(-1)?.kind, 'lease-recovered');
    assert.equal(after.controlEvents.at(-1)?.reason, 'crashed laptop');
  });

  it('refuses a live owner, even with --force, and never touches the lock', async () => {
    const setup = await orchestrationProject(temp);
    const held = await acquireOrchestrationLease(setup.project.layout, 'live-run', new Date());
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: true }), /still running; it is not stale/);
    assert.equal(await held.isIntact(), true);
    await held.release();
  });

  it('refuses unprovable ownership (other host, unknown run) unless forced with a human approval bound to the exact lock', async () => {
    const setup = await orchestrationProject(temp);
    const content = await staleLease(setup, { pid: 1234, host: 'some-other-machine' });
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: false }), /cannot prove the lock owner is gone: the owner ran on another machine/);

    const requested = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'machine was wiped', force: true });
    assert.equal(requested.kind, 'approval-required');
    assert.equal(await readFile(setup.project.layout.orchestrationLockFile, 'utf8'), content, 'nothing removed without approval');
    const id = requested.kind === 'approval-required' ? requested.approvalId : '';
    const approval = (await setup.store.load()).approvals.find((candidate) => candidate.id === id)!;
    assert.equal(approval.type, 'lease-recovery');

    // Token mismatch: the lock is replaced after the approval was requested; the approval no longer applies.
    await staleLease(setup, { pid: 1234, host: 'some-other-machine' });
    await writeFile(setup.project.layout.orchestrationLockFile, content.replace('abc123', 'zzz999'));
    await setup.store.update((state) => resolveApproval(state, id, 'approved', 'yes', new Date(), approval.fingerprint).state);
    const mismatch = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'again', force: true });
    assert.equal(mismatch.kind, 'approval-required', 'a different lock needs its own approval');
    assert.notEqual(mismatch.kind === 'approval-required' && mismatch.approvalId, id);

    const superseded = (await setup.store.load()).approvals.find((candidate) => candidate.id === id)!;
    assert.equal(superseded.status, 'invalidated', 'replacing the lock invalidated the earlier approval');

    // Restoring the original bytes does not resurrect it: a fresh request must be approved.
    await writeFile(setup.project.layout.orchestrationLockFile, content);
    const fresh = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'machine was wiped', force: true });
    assert.equal(fresh.kind, 'approval-required');
    const freshId = fresh.kind === 'approval-required' ? fresh.approvalId : '';
    await setup.store.update((state) => {
      const pending = state.approvals.find((candidate) => candidate.id === freshId)!;
      return resolveApproval(state, freshId, 'approved', 'Confirmed: that machine is gone', new Date(), pending.fingerprint).state;
    });
    const recovered = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'machine was wiped', force: true });
    assert.equal(recovered.kind, 'recovered');
    assert.equal(recovered.kind === 'recovered' && recovered.forced, true);
    await assert.rejects(readFile(setup.project.layout.orchestrationLockFile));
    const state = await setup.store.load();
    assert.equal(state.approvals.find((candidate) => candidate.id === freshId)!.status, 'consumed');
    assert.match(state.controlEvents.at(-1)?.detail ?? '', /forced with approval/);
  });

  it('also removes the state lock a crash during an edit-enabled task leaves behind, when its owner is provably dead', async () => {
    const setup = await orchestrationProject(temp);
    const runId = await crashedRunRecord(setup);
    await staleLease(setup, { pid: 999_999_999, host: hostname(), runId });
    await writeFile(setup.project.layout.lockFile, JSON.stringify({ pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString(), token: 't' }));
    const preflight = await runPreflight({ project: setup.project, store: setup.store, runner });
    assert.equal(preflight.checks.find((check) => check.id === 'state-lock')?.status, 'fail');
    const result = await recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'killed', force: false });
    assert.equal(result.kind === 'recovered' && result.stateLockRemoved, true);
    await assert.rejects(readFile(setup.project.layout.lockFile));
    await assert.rejects(readFile(setup.project.layout.orchestrationLockFile));
  });

  it('refuses a state lock held by a live process or one that does not record its host', async () => {
    const setup = await orchestrationProject(temp);
    await writeFile(setup.project.layout.lockFile, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), token: 't' }));
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: true }), /still running \(a Forge command is writing state\)/);
    await writeFile(setup.project.layout.lockFile, JSON.stringify({ pid: 999_999_999, acquiredAt: new Date().toISOString(), token: 't' }));
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: false }), /does not record its host/);
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: true }), /Remove .forge\/state.lock by hand/);
    assert.ok((await readFile(setup.project.layout.lockFile, 'utf8')).includes('999999999'), 'never removed without proof');
  });

  it('refuses a lock naming a run that state does not know (run mismatch)', async () => {
    const setup = await orchestrationProject(temp);
    await staleLease(setup, { pid: 999_999_999, host: hostname(), runId: 'not-in-state' });
    await assert.rejects(recoverOrchestrationLease({ project: setup.project, store: setup.store, reason: 'x', force: false }), /which this project's state does not know/);
  });
});

describe('preflight', () => {
  const registries = (available = true) => ({
    workers: fakeRegistry(new FakeWorker(async () => ({}), { id: 'claude', available })),
    aiProviders: aiRegistry(FakeAiProvider.answering('{}', 'claude')),
  });

  it('passes a healthy project, reading nothing it writes', async () => {
    const setup = await orchestrationProject(temp);
    const before = await readFile(setup.project.layout.stateFile, 'utf8');
    const report = await runPreflight({ project: setup.project, store: setup.store, runner, registries: registries() });
    assert.equal(report.runnable, true);
    assert.deepEqual(
      report.checks.filter((check) => check.status !== 'pass').map((check) => check.id),
      [],
    );
    assert.equal(await readFile(setup.project.layout.stateFile, 'utf8'), before);
  });

  it('reports each problem with the right severity', async () => {
    const setup = await orchestrationProject(temp, { checks: false });
    await pause(setup);
    const report = await runPreflight({ project: setup.project, store: setup.store, runner, registries: registries(false), policy: buildPolicy({ access: 'edit' }, DEFAULTS) });
    const status = (id: string) => report.checks.find((check) => check.id === id)?.status;
    assert.equal(status('validation'), 'warn');
    assert.equal(status('paused'), 'fail');
    assert.equal(status('provider-implementer'), 'fail');
    assert.equal(report.runnable, false);
  });

  it('fails on merge conflicts, a stale lease, invalid state, and invalid config', async () => {
    const setup = await orchestrationProject(temp);
    await git(setup.root, 'checkout', '-q', '-b', 'other');
    await write(setup.root, 'README.md', '# other\n');
    await git(setup.root, 'commit', '-q', '-am', 'other');
    await git(setup.root, 'checkout', '-q', '-');
    await write(setup.root, 'README.md', '# mine\n');
    await git(setup.root, 'commit', '-q', '-am', 'mine');
    await runner.run({ command: 'git', args: ['merge', 'other'], cwd: setup.root });
    await writeFile(setup.project.layout.orchestrationLockFile, JSON.stringify({ runId: 'r', pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString() }));
    await writeFile(join(setup.project.layout.forgeDir, 'config.json'), JSON.stringify({ schemaVersion: 1, settings: { 'run.maxTasks': 999 }, updatedAt: null }));
    const report = await runPreflight({ project: setup.project, store: setup.store, runner });
    const check = (id: string) => report.checks.find((candidate) => candidate.id === id)!;
    assert.equal(check('git').status, 'fail');
    assert.equal(check('lease').status, 'fail');
    assert.match(check('lease').detail, /no longer exists/);
    assert.equal(check('config').status, 'fail');
    assert.match(check('config').detail, /between 1 and 50/);

    await writeFile(setup.project.layout.stateFile, '{"schemaVersion": 7}');
    assert.equal((await runPreflight({ project: setup.project, store: setup.store, runner })).checks.find((candidate) => candidate.id === 'state')!.status, 'fail');
  });

  it('warns about pending approvals and interrupted tasks, and fails on an unavailable required reviewer', async () => {
    const setup = await orchestrationProject(temp);
    const crashing = scriptedWorker(setup.root, [
      async () => {
        throw new Error('crash');
      },
    ]);
    await assert.rejects(setup.engine.runTask('1.1', { worker: crashing, access: 'edit', timeoutMs: 60_000 }));
    await makeOrchestrator(setup, scriptedWorker(setup.root, [{}]), {}, { liveness: () => false }).run();
    const unavailableReviewer = new FakeAiProvider(async () => ({}), 'claude');
    unavailableReviewer.healthCheck = async () => ({ workerId: 'claude', available: false, version: null, executable: null, authenticated: null, checks: [{ name: 'executable', ok: false, detail: 'missing' }] });
    const report = await runPreflight({
      project: setup.project,
      store: setup.store,
      runner,
      liveness: () => false,
      policy: buildPolicy({ access: 'edit', review: true }, DEFAULTS),
      registries: { workers: registries().workers, aiProviders: aiRegistry(unavailableReviewer) },
    });
    const status = (id: string) => report.checks.find((check) => check.id === id)?.status;
    assert.equal(status('approvals'), 'warn');
    assert.equal(status('tasks'), 'warn');
    assert.equal(status('provider-reviewer'), 'fail');
  });
});

describe('project configuration', () => {
  it('sets, gets, resets and validates typed keys atomically', async () => {
    const setup = await orchestrationProject(temp);
    const store = new ProjectConfigStore(setup.project.layout);
    assert.deepEqual((await store.load()).settings, {});
    await store.set('run.maxTasks', 7);
    await store.set('run.autoCommit', true);
    const config = await store.load();
    assert.deepEqual(config.settings, { 'run.maxTasks': 7, 'run.autoCommit': true });
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).schemaVersion, 1);
    const effective = effectiveSettings(config, { workerTimeoutMs: 600_000, workerTimeoutFromEnv: false });
    assert.deepEqual(effective.find((setting) => setting.key === 'run.maxTasks'), { key: 'run.maxTasks', value: 7, source: 'project', description: 'Distinct tasks per run' });
    assert.equal(effective.find((setting) => setting.key === 'run.maxSteps')!.source, 'default');
    assert.equal((await store.reset('run.maxTasks')).previous, 7);
    assert.deepEqual((await store.load()).settings, { 'run.autoCommit': true });
  });

  it('refuses unknown keys, wrong types, out-of-range values, and credentials', async () => {
    const setup = await orchestrationProject(temp);
    const store = new ProjectConfigStore(setup.project.layout);
    const { parseSettingValue, describeUnknownKey } = await import('../src/config/index.ts');
    assert.throws(() => parseSettingValue('run.maxTasks', '51'), /between 1 and 50/);
    assert.throws(() => parseSettingValue('run.maxTasks', '-1'), ProjectConfigError);
    assert.throws(() => parseSettingValue('run.autoCommit', 'yes'), /true or false/);
    assert.throws(() => parseSettingValue('providers.implementer', 'sk-ant-api03-abcdef'), /credential/);
    assert.match(describeUnknownKey('api.token'), /looks like a credential/);
    assert.match(describeUnknownKey('run.parallel'), /Unknown configuration key/);
    await writeFile(store.file, JSON.stringify({ schemaVersion: 1, settings: { 'run.maxSteps': 5, nested: { path: 1 } }, updatedAt: null }));
    await assert.rejects(store.load(), /nested/);
    // reset repairs an invalid file by removing the offending key (the rest must validate).
    assert.deepEqual((await store.reset('nested')).previous, { path: 1 });
    assert.deepEqual((await store.load()).settings, { 'run.maxSteps': 5 });
  });

  it('precedence: hard limits > CLI > project > default, and project reviewer alone never enables review', () => {
    const project = { 'run.maxTasks': 9, 'run.autoCommit': true, 'providers.reviewer': 'claude' } as const;
    const fromProject = resolvePolicy({}, project, DEFAULTS);
    assert.deepEqual([fromProject.policy.maxTasks, fromProject.policy.autoCommit, fromProject.policy.review.enabled], [9, true, false]);
    assert.deepEqual([fromProject.sources.maxTasks, fromProject.sources.autoCommit], ['project', 'project']);
    const cli = resolvePolicy({ maxTasks: 2, autoCommit: false }, project, DEFAULTS);
    assert.deepEqual([cli.policy.maxTasks, cli.policy.autoCommit, cli.sources.maxTasks], [2, false, 'cli']);
    assert.equal(resolvePolicy({}, {}, DEFAULTS).policy.maxTasks, 5);
    assert.throws(() => resolvePolicy({ maxTasks: 51 }, project, DEFAULTS), ValidationError);
    assert.throws(() => resolvePolicy({}, { 'run.maxSteps': 500 } as never, DEFAULTS), ValidationError);
  });
});

describe('explain and audit', () => {
  it('explain is deterministic, read-only, and names the stop, evidence, and next command', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': `${MULTIPLY}// BUG\n` }]);
    await makeOrchestrator(setup, worker).run();
    const before = await readFile(setup.project.layout.stateFile, 'utf8');
    const state = await setup.store.load();
    const policy = state.orchestrationRuns.at(-1)!.policy;
    const first = explain({ state, view: deriveWorkflow(state), policy });
    const second = explain({ state, view: deriveWorkflow(state), policy });
    assert.deepEqual(first, second);
    const text = first.join('\n');
    assert.match(text, /Forge stopped because Task 1\.1 failed deterministic validation and automatic repair is not permitted/);
    assert.match(text, /Deterministic validation: FAILED/);
    assert.match(text, /Automatic repair: disabled/);
    assert.match(text, /forge approval approve [0-9a-f]{8} --reason/);
    assert.equal(await readFile(setup.project.layout.stateFile, 'utf8'), before);
  });

  it('audit derives a bounded chronological history from authoritative records', async () => {
    const setup = await orchestrationProject(temp);
    await makeOrchestrator(setup, scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]), { autoCommit: true }).run();
    await pause(setup, 'audit me');
    const state = await setup.store.load();
    const events = deriveAudit(state, deriveWorkflow(state));
    const kinds = events.map((event) => event.kind);
    for (const kind of ['run started', 'attempt started', 'attempt finished', 'commit', 'milestone completed', 'run stopped', 'paused']) {
      assert.ok(kinds.includes(kind), kind);
    }
    assert.ok(events.every((event, index) => index === 0 || events[index - 1]!.at <= event.at), 'chronological');
    assert.ok(events.every((event) => event.detail.length <= 160));
  });
});
