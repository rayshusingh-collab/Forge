import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

import { StateConflictError } from '../src/core/errors.ts';
import { openStateStore } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { WORKER_RUN_LIMITS } from '../src/state/index.ts';
import { prepareWorkerRequest, runRecordedWorker } from '../src/workers/index.ts';
import { TempDirs } from './fixtures.ts';
import { FakeWorker, createTestProject } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

async function setup(): Promise<{ project: LoadedProject }> {
  return { project: await createTestProject(temp) };
}

function request(project: LoadedProject, task = 'Summarize the repository') {
  return prepareWorkerRequest({ project, task, access: 'read-only', timeoutMs: 60_000 });
}

describe('runRecordedWorker', () => {
  it('persists a successful run with bounded metadata', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    const worker = new FakeWorker(async () => ({ summary: 'Everything looks fine.', durationMs: 1234 }));
    const req = await request(project);

    const { result, record, persistenceError } = await runRecordedWorker({ worker, request: req, project, store, trigger: 'manual' });

    assert.equal(persistenceError, undefined);
    assert.equal(result.outcome, 'success');
    const state = await store.load();
    assert.equal(state.workerRuns.length, 1);
    const stored = state.workerRuns[0]!;
    assert.deepEqual(stored, record);
    assert.equal(stored.id, req.id);
    assert.equal(stored.worker, 'fake');
    assert.equal(stored.trigger, 'manual');
    assert.equal(stored.access, 'read-only');
    assert.equal(stored.status, 'success');
    assert.equal(stored.task, 'Summarize the repository');
    assert.equal(stored.workingDirectory, '.');
    assert.equal(stored.durationMs, 1234);
    assert.equal(stored.summary, 'Everything looks fine.');
    assert.equal(stored.diagnostic, null);
    assert.notEqual(stored.finishedAt, null);
  });

  it('persists a failed run with its diagnostic', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    const worker = new FakeWorker(async () => ({
      outcome: 'failed',
      summary: null,
      diagnostics: ['Claude Code reported error_during_execution: overloaded', 'stderr: details'],
    }));
    await runRecordedWorker({ worker, request: await request(project), project, store, trigger: 'manual' });

    const stored = (await store.load()).workerRuns[0]!;
    assert.equal(stored.status, 'failed');
    assert.equal(stored.summary, null);
    assert.equal(stored.diagnostic, 'Claude Code reported error_during_execution: overloaded');
  });

  it('records timeouts and cancellations as such', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    for (const outcome of ['timeout', 'cancelled', 'unavailable', 'invalid-output'] as const) {
      await runRecordedWorker({
        worker: new FakeWorker(async () => ({ outcome, summary: null, diagnostics: [outcome] })),
        request: await request(project),
        project,
        store,
        trigger: 'manual',
      });
    }
    assert.deepEqual(
      (await store.load()).workerRuns.map((run) => run.status),
      ['timeout', 'cancelled', 'unavailable', 'invalid-output'],
    );
  });

  it('bounds stored text regardless of worker output', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    const worker = new FakeWorker(async () => ({ summary: 's'.repeat(50_000), diagnostics: ['d'.repeat(50_000)] }));
    await runRecordedWorker({ worker, request: await request(project, 't'.repeat(10_000)), project, store, trigger: 'manual' });

    const stored = (await store.load()).workerRuns[0]!;
    assert.equal(stored.task.length, WORKER_RUN_LIMITS.taskExcerpt);
    assert.equal(stored.summary?.length, WORKER_RUN_LIMITS.summary);
    assert.equal(stored.diagnostic?.length, WORKER_RUN_LIMITS.diagnostic);
  });

  it('writes a running record before the worker starts', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    let seenDuringRun: string | undefined;
    const worker = new FakeWorker(async (req) => {
      seenDuringRun = (await store.load()).workerRuns.find((run) => run.id === req.id)?.status;
      return {};
    });
    await runRecordedWorker({ worker, request: await request(project), project, store, trigger: 'manual' });
    assert.equal(seenDuringRun, 'running');
  });

  it('keeps only the most recent runs', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    const state = await store.load();
    const at = state.createdAt;
    const old = Array.from({ length: WORKER_RUN_LIMITS.retainedRuns }, (_, index) => ({
      id: `old-${index}`,
      worker: 'fake',
      trigger: 'manual' as const,
      access: 'read-only' as const,
      task: 'old',
      workingDirectory: '.',
      status: 'success' as const,
      startedAt: at,
      finishedAt: at,
      durationMs: 1,
      summary: null,
      diagnostic: null,
    }));
    await store.save({ ...state, workerRuns: old });

    const req = await request(project);
    await runRecordedWorker({ worker: new FakeWorker(), request: req, project, store, trigger: 'manual' });

    const runs = (await store.load()).workerRuns;
    assert.equal(runs.length, WORKER_RUN_LIMITS.retainedRuns);
    assert.equal(runs[0]?.id, 'old-1');
    assert.equal(runs.at(-1)?.id, req.id);
  });

  it('preserves concurrent state changes made while the worker runs', async () => {
    const { project } = await setup();
    const store = openStateStore(project);
    const worker = new FakeWorker(async () => {
      // Another Forge process updates state mid-run.
      const current = await store.load();
      await store.save({ ...current, phase: 'planning' });
      return {};
    });
    const { persistenceError } = await runRecordedWorker({ worker, request: await request(project), project, store, trigger: 'manual' });

    assert.equal(persistenceError, undefined);
    const state = await store.load();
    assert.equal(state.phase, 'planning', 'the other writer’s change must survive');
    assert.equal(state.workerRuns[0]?.status, 'success');
  });

  it('does not start the worker when state cannot be written', async () => {
    const { project } = await setup();
    const store = openStateStore(project, { lockTimeoutMs: 200 });
    await writeFile(project.layout.lockFile, '{"pid":99999}');
    const worker = new FakeWorker();

    await assert.rejects(
      runRecordedWorker({ worker, request: await request(project), project, store, trigger: 'manual' }),
      StateConflictError,
    );
    assert.equal(worker.requests.length, 0);
  });

  it('returns the result even if the outcome cannot be persisted', async () => {
    const { project } = await setup();
    const store = openStateStore(project, { lockTimeoutMs: 200 });
    const worker = new FakeWorker(async () => {
      await writeFile(project.layout.lockFile, '{"pid":99999}');
      return { summary: 'done' };
    });
    const { result, record, persistenceError } = await runRecordedWorker({
      worker,
      request: await request(project),
      project,
      store,
      trigger: 'manual',
    });
    assert.equal(result.outcome, 'success');
    assert.equal(record, undefined);
    assert.ok(persistenceError instanceof StateConflictError);
  });
});
