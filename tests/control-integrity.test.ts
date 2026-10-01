import assert from 'node:assert/strict';
import { readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import { IntegrityError, StateConflictError } from '../src/core/errors.ts';
import { silentLogger } from '../src/logging/index.ts';
import { openStateStore } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { prepareWorkerRequest, runRecordedWorker } from '../src/workers/index.ts';
import type { WorkerRequest, WorkerResult } from '../src/workers/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { FakeWorker, createTestProject, fakeRegistry } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

interface Scenario {
  readonly project: LoadedProject;
  readonly evidenceDirectory: string;
}

async function scenario(): Promise<Scenario> {
  return { project: await createTestProject(temp), evidenceDirectory: await temp.make('forge-evidence-') };
}

/** Runs an edit-enabled fake worker whose behavior may tamper with `.forge/`. */
async function editRun(
  { project, evidenceDirectory }: Scenario,
  behave: (request: WorkerRequest) => Promise<Partial<WorkerResult> | void> = async () => {},
  access: 'edit' | 'read-only' = 'edit',
) {
  const worker = new FakeWorker(async (request) => (await behave(request)) ?? {});
  const request = await prepareWorkerRequest({ project, task: 'Change code', access, timeoutMs: 60_000 });
  const run = await runRecordedWorker({ worker, request, project, trigger: 'manual', evidenceDirectory });
  return { run, worker, request };
}

async function readForge(project: LoadedProject, name: string): Promise<string> {
  return readFile(join(project.layout.forgeDir, name), 'utf8');
}

async function evidenceOf(path: string | undefined): Promise<Record<string, unknown>> {
  assert.ok(path, 'an evidence report should have been written');
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('control-state guard: legitimate runs', () => {
  it('passes an edit-enabled run that leaves .forge untouched, including Forge’s own run records', async () => {
    const s = await scenario();
    const revisionBefore = (await openStateStore(s.project).load()).revision;

    const { run, request } = await editRun(s, async () => {
      // Ordinary project edits are fine.
      await writeFile(join(s.project.layout.root, 'feature.js'), 'export {};\n');
    });

    assert.equal(run.integrity.ok, true);
    assert.equal(run.status, 'success');
    assert.equal(run.persistenceError, undefined);
    const state = await openStateStore(s.project).load();
    assert.equal(state.revision, revisionBefore + 2, 'running + final records were both written by Forge');
    assert.equal(state.workerRuns.at(-1)?.id, request.id);
    assert.equal(state.workerRuns.at(-1)?.status, 'success');
    assert.deepEqual((await readdir(s.project.layout.forgeDir)).sort(), ['.gitignore', 'project.json', 'state.json']);
    assert.deepEqual(await readdir(s.evidenceDirectory), []);
  });

  it('blocks concurrent state writers during an edit run instead of mistaking them for tampering', async () => {
    const s = await scenario();
    let concurrentError: unknown;
    const { run } = await editRun(s, async () => {
      // Another Forge process tries to update state while the worker runs.
      const other = openStateStore(s.project, { lockTimeoutMs: 200 });
      concurrentError = await other.update((state) => ({ ...state, phase: 'planning' })).catch((error: unknown) => error);
    });

    assert.ok(concurrentError instanceof StateConflictError, 'the other writer waits and then fails loudly');
    assert.equal(run.integrity.ok, true);
    assert.equal(run.status, 'success');
    assert.equal((await openStateStore(s.project).load()).phase, 'idle');
  });

  it('lets other writers proceed after the edit run releases the lease', async () => {
    const s = await scenario();
    await editRun(s);
    const updated = await openStateStore(s.project, { lockTimeoutMs: 200 }).update((state) => ({ ...state, phase: 'planning' }));
    assert.equal(updated.phase, 'planning');
  });

  it('does not treat concurrent state updates during a read-only run as tampering', async () => {
    const s = await scenario();
    const { run } = await editRun(
      s,
      async () => {
        await openStateStore(s.project).update((state) => ({ ...state, phase: 'planning' }));
      },
      'read-only',
    );
    assert.equal(run.integrity.ok, true);
    assert.equal(run.status, 'success');
    const state = await openStateStore(s.project).load();
    assert.equal(state.phase, 'planning', 'the concurrent change survives');
    assert.equal(state.workerRuns.at(-1)?.status, 'success');
  });

  it('does not start an edit run while another Forge process holds the state lock', async () => {
    const s = await scenario();
    await writeFile(s.project.layout.lockFile, '{"pid":99999}');
    const worker = new FakeWorker();
    const request = await prepareWorkerRequest({ project: s.project, task: 't', access: 'edit', timeoutMs: 60_000 });
    await assert.rejects(
      runRecordedWorker({ worker, request, project: s.project, store: openStateStore(s.project, { lockTimeoutMs: 200 }), trigger: 'manual' }),
      StateConflictError,
    );
    assert.equal(worker.requests.length, 0);
    assert.equal(await readForge(s.project, 'state.lock'), '{"pid":99999}', 'a foreign lock is never removed');
  });
});

describe('control-state guard: tampering', () => {
  it('detects modification of project.json, records the violation, and leaves the file as found', async () => {
    const s = await scenario();
    const original = await readForge(s.project, 'project.json');
    const tampered = original.replace(/"name": "[^"]*"/, '"name": "hijacked"');

    const { run, request } = await editRun(s, async () => {
      await writeFile(s.project.layout.projectFile, tampered);
    });

    assert.equal(run.status, 'integrity-violation');
    assert.equal(run.result.outcome, 'success', 'the worker claimed success');
    assert.deepEqual(run.integrity.changes.map((change) => `${change.change} ${change.path}`), ['modified project.json']);
    assert.equal(await readForge(s.project, 'project.json'), tampered, 'Forge must not restore the old file');

    // state.json and the lock were untouched, so the violation is safely recorded.
    assert.equal(run.persistenceError, undefined);
    const stored = (await openStateStore(s.project).load()).workerRuns.find((record) => record.id === request.id);
    assert.equal(stored?.status, 'integrity-violation');
    assert.match(stored?.diagnostic ?? '', /control state changed during the run: modified \.forge\/project\.json/);

    const evidence = await evidenceOf(run.evidencePath);
    assert.equal(evidence['runId'], request.id);
    const originals = evidence['originals'] as Record<string, { content: string }>;
    assert.equal(originals['project.json']?.content, original);
  });

  it('detects a well-formed forgery of state.json and fails closed without writing state', async () => {
    const s = await scenario();
    const { run } = await editRun(s, async () => {
      const current = JSON.parse(await readForge(s.project, 'state.json')) as Record<string, unknown>;
      // A valid-looking state that mimics a legitimate Forge write.
      const forged = { ...current, revision: (current['revision'] as number) + 1, phase: 'completed' };
      await writeFile(s.project.layout.stateFile, `${JSON.stringify(forged, null, 2)}\n`);
    });
    const forgedOnDisk = await readForge(s.project, 'state.json');

    assert.equal(run.status, 'integrity-violation');
    assert.equal(run.integrity.stateFileChanged, true);
    assert.ok(run.persistenceError instanceof IntegrityError);
    assert.equal(run.record, undefined);
    assert.equal(await readForge(s.project, 'state.json'), forgedOnDisk, 'Forge wrote nothing through tampered state');
    assert.equal(JSON.parse(forgedOnDisk).phase, 'completed', 'the worker’s mutation is preserved as evidence');
    await evidenceOf(run.evidencePath);
  });

  it('detects deletion of protected metadata', async () => {
    for (const name of ['project.json', 'state.json', '.gitignore']) {
      const s = await scenario();
      const { run } = await editRun(s, async () => {
        await unlink(join(s.project.layout.forgeDir, name));
      });
      assert.equal(run.status, 'integrity-violation', name);
      assert.ok(run.integrity.changes.some((change) => change.path === name && change.change === 'removed'), name);
      await assert.rejects(readFile(join(s.project.layout.forgeDir, name)), { code: 'ENOENT' }, `${name} is not recreated`);
      if (name === 'state.json') {
        assert.ok(run.persistenceError instanceof IntegrityError);
      }
    }
  });

  it('reports malformed protected metadata after the run', async () => {
    const s = await scenario();
    const { run } = await editRun(s, async () => {
      await writeFile(s.project.layout.stateFile, '{ "truncated": ');
    });
    assert.equal(run.status, 'integrity-violation');
    assert.ok(run.integrity.problems.some((problem) => /state\.json: .*not valid JSON/.test(problem)));
    assert.ok(run.persistenceError instanceof IntegrityError);
    assert.equal(await readForge(s.project, 'state.json'), '{ "truncated": ');
  });

  it('detects tampering with the state lock and does not delete a lock it no longer owns', async () => {
    const s = await scenario();
    const { run } = await editRun(s, async () => {
      await unlink(s.project.layout.lockFile);
      await writeFile(s.project.layout.lockFile, '{"pid":1}');
    });
    assert.equal(run.status, 'integrity-violation');
    assert.equal(run.integrity.lockFileChanged, true);
    assert.ok(run.persistenceError instanceof IntegrityError);
    assert.equal(await readForge(s.project, 'state.lock'), '{"pid":1}');
  });

  it('detects files added to .forge', async () => {
    const s = await scenario();
    const { run } = await editRun(s, async () => {
      await writeFile(join(s.project.layout.forgeDir, 'extra.json'), '{}');
    });
    assert.equal(run.status, 'integrity-violation');
    assert.deepEqual(run.integrity.changes.map((change) => `${change.change} ${change.path}`), ['added extra.json']);
    assert.equal(run.persistenceError, undefined, 'state itself is untouched, so the violation is recorded');
  });

  it('fails closed when .forge itself is removed', async () => {
    const s = await scenario();
    const { run } = await editRun(s, async () => {
      await rm(s.project.layout.forgeDir, { recursive: true, force: true });
    });
    assert.equal(run.status, 'integrity-violation');
    assert.equal(run.integrity.controlDirectoryReplaced, true);
    assert.ok(run.persistenceError instanceof IntegrityError);
    await assert.rejects(readdir(s.project.layout.forgeDir), { code: 'ENOENT' }, 'Forge must not recreate it');
  });

  it('catches metadata changes during a read-only run with the cheap check', async () => {
    const s = await scenario();
    const { run } = await editRun(
      s,
      async () => {
        await writeFile(s.project.layout.gitignoreFile, '');
      },
      'read-only',
    );
    assert.equal(run.status, 'integrity-violation');
    assert.equal(run.integrity.scope, 'metadata');
  });

  it('protects the trusted validation profile during read-only runs too', async () => {
    const s = await scenario();
    const { run } = await editRun(
      s,
      async () => {
        await writeFile(join(s.project.layout.forgeDir, 'validation.json'), '{"schemaVersion":1,"checks":[],"updatedAt":null}');
      },
      'read-only',
    );
    assert.equal(run.status, 'integrity-violation');
    assert.deepEqual(run.integrity.changes.map((change) => `${change.change} ${change.path}`), ['added validation.json']);
  });
});

describe('control-state guard: reporting', () => {
  it('never reports an integrity violation as success on the CLI', async () => {
    const s = await scenario();
    const worker = new FakeWorker(async () => {
      await writeFile(s.project.layout.projectFile, '{}');
      return { outcome: 'success', summary: 'All done, everything is fine.' };
    });
    const stdout = new CapturingWriter();
    const stderr = new CapturingWriter();

    const exitCode = await runCli(['worker', 'run', 'fake', '--task', 'Refactor', '--allow-edits'], {
      stdout,
      stderr,
      env: {},
      cwd: s.project.layout.root,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
      workers: fakeRegistry(worker),
    });

    assert.equal(exitCode, 1);
    assert.match(stdout.text, /Outcome:\s+integrity-violation/);
    assert.match(stdout.text, /Worker reported: success \(overridden by Forge\)/);
    assert.doesNotMatch(stdout.text, /Outcome:\s+success/);
    assert.match(stderr.text, /SECURITY: Forge control state \(\.forge\/\) was modified/);
    assert.match(stderr.text, /modified: \.forge\/project\.json/);
    assert.match(stderr.text, /now invalid: project\.json/);
    const evidence = /Evidence report: (.+)/.exec(stderr.text)?.[1];
    assert.ok(evidence !== undefined && evidence !== 'could not be written');
    await rm(evidence.trim(), { force: true });
  });
});
