import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { discoverProject, openStateStore } from '../src/projects/index.ts';
import type { TaskRecord } from '../src/state/index.ts';
import { silentLogger } from '../src/logging/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs, initGitRepo, testRunner } from './fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function forge(argv: readonly string[], cwd: string, env: CliContext['env'] = {}): Promise<CliRun> {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const exitCode = await runCli(argv, {
    stdout,
    stderr,
    env,
    cwd,
    version: '0.0.0-test',
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: silentLogger,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function newRepo(name = 'app'): Promise<string> {
  return initGitRepo(join(await temp.make('forge-cli-'), name));
}

describe('forge project add', () => {
  it('registers a repository', async () => {
    const root = await newRepo('web-shop');
    const run = await forge(['project', 'add', root, '--name', 'Web Shop', '--description', 'Storefront'], root);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /Registered project "Web Shop"/);
    assert.match(run.stdout, /ID:\s+[0-9a-f-]{36}/);
    assert.match(run.stdout, /Description:\s+Storefront/);
  });

  it('resolves a relative path against the working directory', async () => {
    const root = await newRepo('relative');
    const run = await forge(['project', 'add', 'relative'], join(root, '..'));
    assert.equal(run.exitCode, 0, run.stderr);
  });

  it('fails clearly for a non-Git directory', async () => {
    const dir = await temp.make('forge-cli-nogit-');
    const run = await forge(['project', 'add', dir], dir);
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /not a Git work tree/);
    assert.equal(run.stdout, '');
  });

  it('fails on duplicate registration', async () => {
    const root = await newRepo();
    assert.equal((await forge(['project', 'add', root], root)).exitCode, 0);
    const second = await forge(['project', 'add', root], root);
    assert.equal(second.exitCode, 1);
    assert.match(second.stderr, /already registered/);
  });

  it('requires exactly one path', async () => {
    const root = await newRepo();
    assert.equal((await forge(['project', 'add'], root)).exitCode, 2);
    assert.equal((await forge(['project', 'add', 'a', 'b'], root)).exitCode, 2);
  });

  it('rejects unknown options', async () => {
    const root = await newRepo();
    const run = await forge(['project', 'add', root, '--force'], root);
    assert.equal(run.exitCode, 2);
    assert.match(run.stderr, /--force/);
  });

  it('requires valid configuration', async () => {
    const root = await newRepo();
    const run = await forge(['project', 'add', root], root, { FORGE_PROCESS_TIMEOUT_MS: 'soon' });
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /FORGE_PROCESS_TIMEOUT_MS/);
  });
});

describe('forge project show / status', () => {
  it('shows the project discovered from a nested directory', async () => {
    const root = await newRepo('discoverable');
    await forge(['project', 'add', root], root);
    const nested = join(root, 'src', 'lib');
    await mkdir(nested, { recursive: true });

    const run = await forge(['project', 'show'], nested);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /Name:\s+discoverable/);
    assert.match(run.stdout, /Status:\s+active/);
    assert.match(run.stdout, /Schema:\s+v1/);
  });

  it('shows the initial status', async () => {
    const root = await newRepo();
    await forge(['project', 'add', root], root);

    const run = await forge(['project', 'status'], root);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /Phase:\s+idle/);
    assert.match(run.stdout, /Milestones:\s+0\n/);
    assert.match(run.stdout, /Tasks:\s+0\n/);
    assert.match(run.stdout, /Runnable:\s+0\n/);
    assert.match(run.stdout, /Attention:\s+none/);
    assert.match(run.stdout, /Revision:\s+1/);
  });

  it('summarizes persisted tasks and pending decisions', async () => {
    const root = await newRepo();
    await forge(['project', 'add', root], root);
    const loaded = await discoverProject(root);
    assert.ok(loaded);
    const store = openStateStore(loaded);
    const state = await store.load();
    const at = state.createdAt;
    const task = (id: string, order: number, dependsOn: string[]): TaskRecord => ({
      id,
      milestoneId: 'm1',
      order,
      title: id,
      instruction: `do ${id}`,
      context: null,
      status: 'pending',
      dependsOn,
      maxAttempts: 3,
      attempts: [],
      cancelReason: null,
      createdAt: at,
      updatedAt: at,
    });
    const executor = { pid: 1, host: 'h' };
    await store.save({
      ...state,
      phase: 'blocked',
      milestones: [{ id: 'm1', order: 1, title: 'M1', description: null, status: 'active', createdAt: at, updatedAt: at }],
      tasks: [
        {
          ...task('t1', 1, []),
          status: 'succeeded',
          attempts: [{ number: 1, runId: 'r1', outcome: 'accepted', executor, startedAt: at, finishedAt: at, note: null, changes: null, validation: null, commit: null }],
        },
        task('t2', 2, ['t1']),
        task('t3', 3, ['t2']),
      ],
      workerRuns: [
        {
          id: 'r1',
          worker: 'fake',
          trigger: 'task',
          access: 'edit',
          taskId: 't1',
          attempt: 1,
          task: 'do t1',
          workingDirectory: '.',
          status: 'success',
          startedAt: at,
          finishedAt: at,
          durationMs: 5,
          summary: null,
          diagnostic: null,
        },
      ],
      decisions: [
        { id: 'd1', taskId: 't2', question: 'OK?', status: 'pending', resolution: null, createdAt: at, resolvedAt: null },
      ],
    });

    const run = await forge(['project', 'status'], root);

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stdout, /Phase:\s+blocked/);
    assert.match(run.stdout, /Milestones:\s+1 \(active 1\)/);
    assert.match(run.stdout, /Tasks:\s+3 \(ready 1, waiting 1, succeeded 1\)/);
    assert.match(run.stdout, /Runnable:\s+1 \(1\.2\)/);
    assert.match(run.stdout, /Attention:\s+1 decision\(s\) pending/);
    assert.match(run.stdout, /Revision:\s+2/);
  });

  it('fails when no project is found', async () => {
    const dir = await temp.make('forge-cli-none-');
    for (const subcommand of ['show', 'status']) {
      const run = await forge(['project', subcommand], dir);
      assert.equal(run.exitCode, 1);
      assert.match(run.stderr, /no Forge project found/);
    }
  });

  it('rejects unexpected arguments', async () => {
    const root = await newRepo();
    assert.equal((await forge(['project', 'show', 'extra'], root)).exitCode, 2);
    assert.equal((await forge(['project', 'status', '--verbose'], root)).exitCode, 2);
  });
});

describe('forge project (dispatch)', () => {
  it('requires a known subcommand', async () => {
    const dir = await temp.make();
    assert.equal((await forge(['project'], dir)).exitCode, 2);
    const run = await forge(['project', 'delete'], dir);
    assert.equal(run.exitCode, 2);
    assert.match(run.stderr, /unknown subcommand "delete"/);
  });

  it('prints project help', async () => {
    const dir = await temp.make();
    const run = await forge(['project', '--help'], dir);
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /add <path>/);
    assert.match(run.stdout, /status/);
  });

  it('lists the project command in top-level help', async () => {
    const run = await forge(['--help'], await temp.make());
    assert.match(run.stdout, /project\s+Register and inspect Forge projects/);
  });
});

describe('persistence across processes', () => {
  it('reloads registered state in a fresh Forge process', async () => {
    const root = await newRepo('persisted');
    const added = await forge(['project', 'add', root], root);
    assert.equal(added.exitCode, 0, added.stderr);
    const id = /ID:\s+(\S+)/.exec(added.stdout)?.[1];
    assert.ok(id);

    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    for (const subcommand of ['show', 'status']) {
      const result = await testRunner.run({ command: process.execPath, args: [entry, 'project', subcommand], cwd: root });
      assert.equal(result.outcome, 'success', result.stderr);
      assert.ok(result.stdout.includes(id), `fresh process output should include ${id}`);
    }
  });
});
