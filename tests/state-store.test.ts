import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

import { StateConflictError, StateError } from '../src/core/errors.ts';
import {
  MAX_DOCUMENT_BYTES,
  STATE_SCHEMA_VERSION,
  StateStore,
  UnsupportedVersionError,
  createInitialState,
  upgradeDocument,
  writeFileAtomic,
} from '../src/state/index.ts';
import type { ProjectState, WorkerRunRecord } from '../src/state/index.ts';
import { TempDirs, tryLinkFile } from './fixtures.ts';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');

const temp = new TempDirs();
after(() => temp.cleanup());

interface Fixture {
  readonly dir: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly store: StateStore;
}

async function fixture(options: { lockTimeoutMs?: number } = {}): Promise<Fixture> {
  const dir = await temp.make('forge-state-');
  const stateFile = join(dir, 'state.json');
  const lockFile = join(dir, 'state.lock');
  const store = new StateStore({ stateFile, lockFile, projectId: PROJECT_ID, clock: () => T1, ...options });
  return { dir, stateFile, lockFile, store };
}

/** A state exercising every record type. */
function populatedState(): ProjectState {
  const at = T0.toISOString();
  const run = (id: string, fields: Partial<WorkerRunRecord>): WorkerRunRecord => ({
    id,
    worker: 'claude-code',
    trigger: 'task',
    access: 'edit',
    taskId: 't1',
    attempt: 1,
    task: 'Add runner',
    workingDirectory: '.',
    status: 'success',
    startedAt: at,
    finishedAt: at,
    durationMs: 1000,
    summary: 'done',
    diagnostic: null,
    ...fields,
  });
  const executor = { pid: 4242, host: 'build-box' };
  return {
    ...createInitialState(PROJECT_ID, T0),
    phase: 'executing',
    milestones: [
      { id: 'm1', order: 1, title: 'Foundation', description: null, status: 'active', createdAt: at, updatedAt: at },
      { id: 'm2', order: 2, title: 'Polish', description: 'Later work', status: 'pending', createdAt: at, updatedAt: at },
    ],
    tasks: [
      {
        id: 't1',
        milestoneId: 'm1',
        order: 1,
        title: 'Add runner',
        instruction: 'Implement a controlled process runner',
        context: 'Use argument arrays',
        status: 'running',
        dependsOn: [],
        maxAttempts: 3,
        attempts: [
          {
            number: 1,
            runId: 'r1',
            outcome: 'rejected',
            executor,
            startedAt: at,
            finishedAt: at,
            note: 'tests missing',
            changes: null,
            validation: {
              status: 'failed',
              profileHash: 'a'.repeat(64),
              startedAt: at,
              finishedAt: at,
              checks: [
                { id: 'typecheck', required: true, status: 'passed', exitCode: 0, durationMs: 10, executable: '/bin/tsc', stdout: null, stderr: null, outputTruncated: false, diagnostic: null },
                { id: 'test', required: true, status: 'failed', exitCode: 1, durationMs: 20, executable: '/bin/node', stdout: '1 failing', stderr: null, outputTruncated: false, diagnostic: 'exited with code 1' },
              ],
            },
            commit: null,
          },
          { number: 2, runId: 'r2', outcome: 'running', executor, startedAt: at, finishedAt: null, note: null, changes: null, validation: null, commit: null },
        ],
        cancelReason: null,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 't2',
        milestoneId: 'm1',
        order: 2,
        title: 'Add tests',
        instruction: 'Test the runner',
        context: null,
        status: 'pending',
        dependsOn: ['t1'],
        maxAttempts: 3,
        attempts: [],
        cancelReason: null,
        createdAt: at,
        updatedAt: at,
      },
    ],
    workerRuns: [
      run('r0', { trigger: 'manual', taskId: null, attempt: null, access: 'read-only', task: 'Inspect' }),
      run('r1', {}),
      run('r2', { attempt: 2, status: 'running', finishedAt: null, durationMs: null, summary: null }),
    ],
    decisions: [
      {
        id: 'd1',
        taskId: 't1',
        question: 'Allow deleting generated files?',
        status: 'pending',
        resolution: null,
        createdAt: at,
        resolvedAt: null,
      },
    ],
  };
}

async function writeRaw(file: string, value: unknown): Promise<void> {
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
}

describe('StateStore: create and load', () => {
  it('creates valid initial state with no placeholder work', async () => {
    const { store } = await fixture();
    const created = await store.create(createInitialState(PROJECT_ID, T0));

    assert.equal(created.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(created.projectId, PROJECT_ID);
    assert.equal(created.revision, 1);
    assert.equal(created.phase, 'idle');
    assert.deepEqual(created.milestones, []);
    assert.deepEqual(created.tasks, []);
    assert.deepEqual(created.decisions, []);
    assert.deepEqual(await store.load(), created);
  });

  it('refuses to create over existing state', async () => {
    const { store } = await fixture();
    await store.create(createInitialState(PROJECT_ID, T0));
    await assert.rejects(store.create(createInitialState(PROJECT_ID, T0)), StateConflictError);
  });

  it('round-trips a fully populated state', async () => {
    const { store } = await fixture();
    await store.create(populatedState());
    assert.deepEqual(await store.load(), populatedState());
  });

  it('reports missing state', async () => {
    const { store } = await fixture();
    await assert.rejects(store.load(), (error: unknown) => {
      assert.ok(error instanceof StateError);
      assert.match(error.message, /missing/);
      return true;
    });
  });
});

describe('StateStore: rejecting bad data', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await fixture();
  });

  async function expectLoadError(content: unknown, pattern: RegExp): Promise<void> {
    await writeRaw(f.stateFile, content);
    await assert.rejects(f.store.load(), (error: unknown) => {
      assert.ok(error instanceof StateError, `expected StateError, got ${String(error)}`);
      assert.match(error.message, pattern);
      return true;
    });
  }

  const valid = (): Record<string, unknown> => JSON.parse(JSON.stringify(populatedState())) as Record<string, unknown>;

  it('rejects malformed JSON', () => expectLoadError('{"schemaVersion": 1, "projectId": ', /not valid JSON/));
  it('rejects an empty file', () => expectLoadError('', /not valid JSON/));
  it('rejects a non-object document', () => expectLoadError('[1, 2, 3]', /must be an object/));
  it('rejects a missing field', async () => {
    const doc = valid();
    delete doc['phase'];
    await expectLoadError(doc, /phase is required/);
  });
  it('rejects a wrong field type', () => expectLoadError({ ...valid(), revision: '3' }, /revision must be an integer/));
  it('rejects an unknown field', () => expectLoadError({ ...valid(), injected: true }, /injected is not a recognised field/));
  it('rejects an invalid enum value', () => expectLoadError({ ...valid(), phase: 'hacking' }, /phase must be one of/));

  it('rejects an invalid nested value with its location', async () => {
    const doc = valid();
    (doc['tasks'] as Record<string, unknown>[])[0]!['status'] = 'done';
    await expectLoadError(doc, /tasks\[0\]\.status must be one of/);
  });

  it('rejects an invalid timestamp', () => expectLoadError({ ...valid(), createdAt: 'yesterday' }, /createdAt must be a UTC ISO-8601/));

  it('rejects a dangling milestone reference', async () => {
    const doc = valid();
    (doc['tasks'] as Record<string, unknown>[])[0]!['milestoneId'] = 'missing';
    await expectLoadError(doc, /references unknown milestone/);
  });

  it('rejects a dangling task reference', async () => {
    const doc = valid();
    (doc['decisions'] as Record<string, unknown>[])[0]!['taskId'] = 'missing';
    await expectLoadError(doc, /references unknown task/);
  });

  it('rejects duplicate IDs', async () => {
    const doc = valid();
    const tasks = doc['tasks'] as Record<string, unknown>[];
    tasks[1]!['id'] = tasks[0]!['id'];
    await expectLoadError(doc, /duplicates "t1"/);
  });

  it('rejects non-sequential attempts', async () => {
    const doc = valid();
    const attempts = (doc['tasks'] as Record<string, unknown>[])[0]!['attempts'] as Record<string, unknown>[];
    attempts[1]!['number'] = 5;
    await expectLoadError(doc, /attempts are sequential/);
  });

  it('rejects inconsistent lifecycle fields', async () => {
    const doc = valid();
    (doc['decisions'] as Record<string, unknown>[])[0]!['status'] = 'approved';
    await expectLoadError(doc, /resolvedAt must be null exactly when the decision is pending/);
  });

  it('rejects a newer schema version', () =>
    expectLoadError({ ...valid(), schemaVersion: STATE_SCHEMA_VERSION + 1 }, /newer than this Forge supports/));

  it('migrates version 1 state (without worker runs) and preserves its content', async () => {
    // Version 1 as Milestone 2 wrote it: no worker runs, no tasks were ever created.
    const decisions = [{ ...populatedState().decisions[0]!, taskId: null }];
    const v1: Record<string, unknown> = { ...valid(), schemaVersion: 1, milestones: [], tasks: [], decisions, phase: 'planning' };
    delete v1['workerRuns'];
    await writeRaw(f.stateFile, v1);
    const loaded = await f.store.load();
    assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual(loaded.workerRuns, []);
    assert.equal(loaded.phase, 'planning');
    assert.deepEqual(loaded.decisions, decisions);

    const saved = await f.store.save({ ...loaded, phase: 'executing' });
    const onDisk = JSON.parse(await readFile(f.stateFile, 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk['schemaVersion'], STATE_SCHEMA_VERSION);
    assert.equal(saved.revision, loaded.revision + 1);
  });

  /** A version 2 document as Milestone 3 wrote it. */
  const v2 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
    const doc: Record<string, unknown> = {
      ...valid(),
      schemaVersion: 2,
      milestones: [],
      tasks: [],
      decisions: [],
      workerRuns: [
        {
          id: 'manual-1',
          worker: 'claude-code',
          trigger: 'manual',
          access: 'read-only',
          task: 'Inspect',
          workingDirectory: '.',
          status: 'success',
          startedAt: T0.toISOString(),
          finishedAt: T0.toISOString(),
          durationMs: 30_000,
          summary: 'A small repo',
          diagnostic: null,
        },
      ],
      ...overrides,
    };
    return doc;
  };

  it('migrates version 2 state: worker runs gain task links, milestones gain order', async () => {
    const milestone = { id: 'm9', title: 'Old', description: null, status: 'in-progress', createdAt: T0.toISOString(), updatedAt: T0.toISOString() };
    await writeRaw(f.stateFile, v2({ milestones: [milestone] }));
    const loaded = await f.store.load();

    assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual(loaded.milestones, [{ ...milestone, order: 1, status: 'active' }]);
    assert.equal(loaded.workerRuns[0]?.taskId, null);
    assert.equal(loaded.workerRuns[0]?.attempt, null);
    assert.equal(loaded.workerRuns[0]?.summary, 'A small repo');
  });

  it('refuses to guess a migration for version 2 placeholder tasks', () =>
    expectLoadError(v2({ tasks: [{ id: 'x' }] }), /version 2 tasks, which cannot be migrated/));

  /** A version 3 document as Milestone 4 wrote it: attempts without changes/commit. */
  const v3 = (validation: unknown = null): Record<string, unknown> => {
    const doc = valid();
    doc['schemaVersion'] = 3;
    for (const task of doc['tasks'] as Record<string, unknown>[]) {
      task['attempts'] = (task['attempts'] as Record<string, unknown>[]).map((attempt) => {
        const { changes: _c, commit: _m, ...rest } = attempt;
        return { ...rest, validation };
      });
    }
    return doc;
  };

  it('migrates version 3 state: attempts gain empty changes, validation, and commit', async () => {
    await writeRaw(f.stateFile, v3());
    const loaded = await f.store.load();
    assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION);
    const attempts = loaded.tasks[0]!.attempts;
    assert.equal(attempts.length, 2);
    for (const attempt of attempts) {
      assert.deepEqual([attempt.changes, attempt.validation, attempt.commit], [null, null, null]);
    }
    assert.equal(attempts[0]!.outcome, 'rejected');
    assert.equal(attempts[0]!.note, 'tests missing');
  });

  it('refuses version 3 validation data it cannot map', () =>
    expectLoadError(v3({ status: 'passed', checks: [], completedAt: T0.toISOString() }), /validation data that schema version 3 never recorded/));

  it('still chains every migration from version 1', async () => {
    const v1: Record<string, unknown> = { ...valid(), schemaVersion: 1, milestones: [], tasks: [], decisions: [] };
    delete v1['workerRuns'];
    await writeRaw(f.stateFile, v1);
    const loaded = await f.store.load();
    assert.equal(loaded.schemaVersion, STATE_SCHEMA_VERSION);
    assert.deepEqual([loaded.tasks, loaded.workerRuns], [[], []]);
  });

  it('rejects version 1 state that already contains version 2 fields', () =>
    expectLoadError({ ...valid(), schemaVersion: 1 }, /workerRuns is not a recognised field in schema version 1/));
  it('rejects a non-integer schema version', () => expectLoadError({ ...valid(), schemaVersion: '1' }, /schemaVersion must be an integer/));
  it('rejects a missing schema version', async () => {
    const doc = valid();
    delete doc['schemaVersion'];
    await expectLoadError(doc, /schemaVersion must be an integer/);
  });

  describe('workflow invariants', () => {
    const tasksOf = (doc: Record<string, unknown>) => doc['tasks'] as Record<string, unknown>[];
    const withT2DependsOn = (dependsOn: string[]) => {
      const doc = valid();
      tasksOf(doc)[1]!['dependsOn'] = dependsOn;
      return doc;
    };

    it('rejects a self-dependency', () => expectLoadError(withT2DependsOn(['t2']), /task "t2" depends on itself/));
    it('rejects a duplicate dependency', () => expectLoadError(withT2DependsOn(['t1', 't1']), /lists dependency "t1" more than once/));
    it('rejects a missing dependency', () => expectLoadError(withT2DependsOn(['ghost']), /depends on unknown task "ghost"/));

    it('rejects a dependency cycle', async () => {
      const doc = withT2DependsOn(['t1']);
      tasksOf(doc)[0]!['dependsOn'] = ['t2'];
      await expectLoadError(doc, /dependency cycle: t1 -> t2 -> t1/);
    });

    it('rejects a status inconsistent with the attempts', async () => {
      const doc = valid();
      tasksOf(doc)[0]!['status'] = 'succeeded';
      await expectLoadError(doc, /"succeeded" is inconsistent with its attempts \(expected "running"\)/);
    });

    it('rejects an attempt linked to the wrong run', async () => {
      const doc = valid();
      const attempts = tasksOf(doc)[0]!['attempts'] as Record<string, unknown>[];
      attempts[1]!['runId'] = 'r1';
      await expectLoadError(doc, /different task or attempt/);
    });

    it('rejects an attempt whose outcome contradicts its run', async () => {
      const doc = valid();
      const runs = doc['workerRuns'] as Record<string, unknown>[];
      runs[1]!['status'] = 'failed';
      await expectLoadError(doc, /"rejected" is inconsistent with its run status "failed"/);
    });

    it('rejects a task run that no attempt refers to', async () => {
      const doc = valid();
      const runs = doc['workerRuns'] as Record<string, unknown>[];
      runs.push({ ...runs[1]!, id: 'orphan', attempt: 3 });
      await expectLoadError(doc, /task run that no task attempt refers to/);
    });

    it('rejects an executed task whose dependency has not succeeded', async () => {
      const doc = withT2DependsOn([]);
      tasksOf(doc)[0]!['dependsOn'] = ['t2'];
      await expectLoadError(doc, /includes a task that has not succeeded, but this task has been executed/);
    });

    it('rejects a completed milestone with unfinished tasks', async () => {
      const doc = valid();
      (doc['milestones'] as Record<string, unknown>[])[0]!['status'] = 'completed';
      await expectLoadError(doc, /cannot be completed unless all tasks are succeeded or cancelled/);
    });

    it('rejects a pending milestone with executed tasks', async () => {
      const doc = valid();
      (doc['milestones'] as Record<string, unknown>[])[0]!['status'] = 'pending';
      await expectLoadError(doc, /cannot be pending while one of its tasks has been executed/);
    });

    it('rejects duplicate milestone order', async () => {
      const doc = valid();
      (doc['milestones'] as Record<string, unknown>[])[1]!['order'] = 1;
      await expectLoadError(doc, /duplicate order 1/);
    });

    it('rejects more attempts than allowed', async () => {
      const doc = valid();
      tasksOf(doc)[0]!['maxAttempts'] = 1;
      await expectLoadError(doc, /exceed maxAttempts/);
    });
  });

  it('rejects state belonging to another project', () =>
    expectLoadError({ ...valid(), projectId: 'other-project' }, /different project/));

  it('rejects an oversized document without parsing it', async () => {
    await writeFile(f.stateFile, Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20));
    await assert.rejects(f.store.load(), /exceeds/);
  });

  it('rejects a state file that is a symbolic link', async (t) => {
    const target = join(f.dir, 'elsewhere.json');
    await writeRaw(target, valid());
    if (!(await tryLinkFile(target, f.stateFile))) {
      t.skip('OS does not permit creating file symlinks');
      return;
    }
    await assert.rejects(f.store.load(), /not a regular file/);
  });

  it('never overwrites corrupted state on save', async () => {
    await writeRaw(f.stateFile, 'corrupted!');
    await assert.rejects(f.store.save(createInitialState(PROJECT_ID, T0)), StateError);
    assert.equal(await readFile(f.stateFile, 'utf8'), 'corrupted!');
  });

  it('refuses to write invalid state', async () => {
    await f.store.create(createInitialState(PROJECT_ID, T0));
    const before = await readFile(f.stateFile, 'utf8');
    const invalid = { ...createInitialState(PROJECT_ID, T0), phase: 'bogus' } as unknown as ProjectState;
    await assert.rejects(f.store.save(invalid), /Refusing to write invalid project state/);
    assert.equal(await readFile(f.stateFile, 'utf8'), before);
  });
});

describe('StateStore: saving and concurrency', () => {
  it('increments the revision and timestamp on save', async () => {
    const { store } = await fixture();
    const loaded = await store.create(createInitialState(PROJECT_ID, T0));

    const saved = await store.save({ ...loaded, phase: 'planning' });

    assert.equal(saved.revision, 2);
    assert.equal(saved.updatedAt, T1.toISOString());
    assert.equal(saved.createdAt, T0.toISOString());
    assert.deepEqual(await store.load(), saved);
  });

  it('rejects a save based on a stale revision (lost-update protection)', async () => {
    const { store } = await fixture();
    await store.create(createInitialState(PROJECT_ID, T0));
    const first = await store.load();
    const second = await store.load();

    await store.save({ ...first, phase: 'planning' });
    await assert.rejects(store.save({ ...second, phase: 'blocked' }), (error: unknown) => {
      assert.ok(error instanceof StateConflictError);
      assert.match(error.message, /expected revision 1, found 2/);
      return true;
    });
    assert.equal((await store.load()).phase, 'planning');
  });

  it('lets exactly one of several concurrent saves win', async () => {
    const { store } = await fixture();
    const base = await store.create(createInitialState(PROJECT_ID, T0));

    const phases = ['planning', 'executing', 'blocked', 'completed', 'idle'] as const;
    const results = await Promise.allSettled(phases.map((phase) => store.save({ ...base, phase })));

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, phases.length - 1);
    for (const result of rejected) {
      assert.ok(result.reason instanceof StateConflictError);
    }
    assert.equal((await store.load()).revision, 2);
  });

  it('waits for, then fails on, a lock held by another process', async () => {
    const { store, lockFile, stateFile } = await fixture({ lockTimeoutMs: 200 });
    const base = await store.create(createInitialState(PROJECT_ID, T0));
    await writeFile(lockFile, JSON.stringify({ pid: 99999 }));
    const before = await readFile(stateFile, 'utf8');

    await assert.rejects(store.save({ ...base, phase: 'planning' }), (error: unknown) => {
      assert.ok(error instanceof StateConflictError);
      assert.match(error.message, /locked by another Forge process/);
      return true;
    });
    assert.equal(await readFile(stateFile, 'utf8'), before);
  });

  it('releases the lock after saving and after failures', async () => {
    const { store, dir } = await fixture();
    const base = await store.create(createInitialState(PROJECT_ID, T0));
    await store.save({ ...base, phase: 'planning' });
    await assert.rejects(store.save({ ...base, phase: 'blocked' }), StateConflictError);

    assert.deepEqual(await readdir(dir), ['state.json']);
  });
});

describe('writeFileAtomic', () => {
  it('replaces content and leaves no temporary files', async () => {
    const dir = await temp.make('forge-atomic-');
    const target = join(dir, 'doc.json');
    await writeFileAtomic(target, 'one');
    await writeFileAtomic(target, 'two');

    assert.equal(await readFile(target, 'utf8'), 'two');
    assert.deepEqual(await readdir(dir), ['doc.json']);
  });

  it('keeps the original and cleans up when the final rename fails', async () => {
    const dir = await temp.make('forge-atomic-');
    const target = join(dir, 'occupied');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'original');

    await assert.rejects(writeFileAtomic(target, 'replacement'));

    assert.deepEqual(await readdir(dir), ['occupied']);
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'original');
  });
});

describe('upgradeDocument', () => {
  it('passes current documents through unchanged', () => {
    const doc = { schemaVersion: 1, value: 'x' };
    assert.equal(upgradeDocument(doc, 1), doc);
  });

  it('applies registered migrations in order', () => {
    const migrated = upgradeDocument({ schemaVersion: 1, a: 1 }, 3, {
      1: (doc) => ({ ...doc, schemaVersion: 2, b: 2 }),
      2: (doc) => ({ ...doc, schemaVersion: 3, c: 3 }),
    });
    assert.deepEqual(migrated, { schemaVersion: 3, a: 1, b: 2, c: 3 });
  });

  it('rejects older versions without a migration', () => {
    assert.throws(() => upgradeDocument({ schemaVersion: 1 }, 2), UnsupportedVersionError);
  });

  it('rejects newer versions', () => {
    assert.throws(() => upgradeDocument({ schemaVersion: 3 }, 2), /newer than this Forge supports/);
  });
});
