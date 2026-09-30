import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { silentLogger } from '../src/logging/index.ts';
import { openStateStore } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import type { WorkerRegistry } from '../src/workers/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { FakeWorker, createTestProject, fakeRegistry } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function forge(
  argv: readonly string[],
  cwd: string,
  workers: WorkerRegistry,
  extra: Partial<CliContext> = {},
): Promise<CliRun> {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const exitCode = await runCli(argv, {
    stdout,
    stderr,
    env: {},
    cwd,
    version: '0.0.0-test',
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: silentLogger,
    workers,
    ...extra,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

async function projectWith(): Promise<LoadedProject> {
  return createTestProject(temp);
}

describe('forge worker run', () => {
  it('runs a worker read-only by default, shows a banner, and records the run', async () => {
    const project = await projectWith();
    const worker = new FakeWorker(async () => ({ summary: 'Repository summary.', provider: { costUsd: 0.0123 } }));

    const run = await forge(['worker', 'run', 'fake', '--task', 'Summarize this repository'], project.layout.root, fakeRegistry(worker));

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stderr, /Forge is invoking AI worker "Fake Worker" \(fake\)/);
    assert.match(run.stderr, /Access:\s+read-only/);
    assert.match(run.stdout, /Outcome:\s+success/);
    assert.match(run.stdout, /Cost:\s+\$0\.0123/);
    assert.match(run.stdout, /Worker summary:\nRepository summary\./);

    const request = worker.requests[0]!;
    assert.equal(request.access, 'read-only');
    assert.equal(request.timeoutMs, 600_000, 'defaults to FORGE_WORKER_TIMEOUT_MS');
    const runs = (await openStateStore(project).load()).workerRuns;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'success');
    assert.equal(runs[0]?.id, request.id);
  });

  it('accepts an alias, context, timeout, subdirectory, and --allow-edits', async () => {
    const project = await projectWith();
    await mkdir(join(project.layout.root, 'pkg'));
    const worker = new FakeWorker();

    const run = await forge(
      ['worker', 'run', 'alias', '--task', 'Fix it', '--context', 'CI is red', '--timeout', '90', '--cwd', 'pkg', '--allow-edits'],
      project.layout.root,
      fakeRegistry(worker),
    );

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stderr, /MAY MODIFY FILES/);
    const request = worker.requests[0]!;
    assert.equal(request.context, 'CI is red');
    assert.equal(request.timeoutMs, 90_000);
    assert.equal(request.relativeWorkingDirectory, 'pkg');
    assert.equal(request.access, 'edit');
  });

  it('resolves --cwd relative to where Forge is run', async () => {
    const project = await projectWith();
    await mkdir(join(project.layout.root, 'a', 'b'), { recursive: true });
    const worker = new FakeWorker();
    await forge(['worker', 'run', 'fake', '--task', 't', '--cwd', 'b'], join(project.layout.root, 'a'), fakeRegistry(worker));
    assert.equal(worker.requests[0]?.relativeWorkingDirectory, 'a/b');
  });

  it('uses the configured default worker timeout', async () => {
    const project = await projectWith();
    const worker = new FakeWorker();
    await forge(['worker', 'run', 'fake', '--task', 't'], project.layout.root, fakeRegistry(worker), {
      env: { FORGE_WORKER_TIMEOUT_MS: '45000' },
    });
    assert.equal(worker.requests[0]?.timeoutMs, 45_000);
  });

  it('reports a failed worker with exit code 1 and records it', async () => {
    const project = await projectWith();
    const worker = new FakeWorker(async () => ({ outcome: 'failed', summary: null, diagnostics: ['Worker gave up'] }));

    const run = await forge(['worker', 'run', 'fake', '--task', 't'], project.layout.root, fakeRegistry(worker));

    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /Outcome:\s+failed/);
    assert.match(run.stdout, /Note:\s+Worker gave up/);
    assert.equal((await openStateStore(project).load()).workerRuns[0]?.status, 'failed');
  });

  it('passes the interrupt signal to the worker', async () => {
    const project = await projectWith();
    const controller = new AbortController();
    controller.abort();
    const worker = new FakeWorker(async (_request, options) => ({
      outcome: options.signal?.aborted === true ? 'cancelled' : 'success',
    }));
    const run = await forge(['worker', 'run', 'fake', '--task', 't'], project.layout.root, fakeRegistry(worker), {
      signal: controller.signal,
    });
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /Outcome:\s+cancelled/);
  });

  it('requires a registered project', async () => {
    const dir = await temp.make('forge-cli-worker-none-');
    const worker = new FakeWorker();
    const run = await forge(['worker', 'run', 'fake', '--task', 't'], dir, fakeRegistry(worker));
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /no Forge project found/);
    assert.equal(worker.requests.length, 0);
  });

  it('rejects an unknown worker', async () => {
    const project = await projectWith();
    const run = await forge(['worker', 'run', 'codex', '--task', 't'], project.layout.root, fakeRegistry(new FakeWorker()));
    assert.equal(run.exitCode, 2);
    assert.match(run.stderr, /unknown worker "codex" \(available: fake, alias\)/);
  });

  it('rejects a working directory outside the project', async () => {
    const project = await projectWith();
    const outside = await temp.make('forge-cli-outside-');
    const worker = new FakeWorker();
    const run = await forge(['worker', 'run', 'fake', '--task', 't', '--cwd', outside], project.layout.root, fakeRegistry(worker));
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /outside the project root/);
    assert.equal(worker.requests.length, 0);
  });

  const usageErrors: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['missing worker', ['worker', 'run', '--task', 't'], /expected exactly one <worker>/],
    ['missing task', ['worker', 'run', 'fake'], /--task <text> is required/],
    ['blank task', ['worker', 'run', 'fake', '--task', '  '], /--task <text> is required/],
    ['zero timeout', ['worker', 'run', 'fake', '--task', 't', '--timeout', '0'], /--timeout must be/],
    ['non-numeric timeout', ['worker', 'run', 'fake', '--task', 't', '--timeout', '10s'], /--timeout must be/],
    ['huge timeout', ['worker', 'run', 'fake', '--task', 't', '--timeout', '999999'], /--timeout must be/],
    ['unknown option', ['worker', 'run', 'fake', '--task', 't', '--dangerously-skip-permissions'], /Unknown option/],
    ['extra argument', ['worker', 'run', 'fake', 'extra', '--task', 't'], /expected exactly one <worker>/],
  ];
  for (const [label, argv, pattern] of usageErrors) {
    it(`rejects ${label}`, async () => {
      const project = await projectWith();
      const worker = new FakeWorker();
      const run = await forge(argv, project.layout.root, fakeRegistry(worker));
      assert.equal(run.exitCode, 2);
      assert.match(run.stderr, pattern);
      assert.equal(worker.requests.length, 0);
    });
  }

  it('rejects an oversized task', async () => {
    const project = await projectWith();
    const run = await forge(['worker', 'run', 'fake', '--task', 'x'.repeat(20_001)], project.layout.root, fakeRegistry(new FakeWorker()));
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /Task is too long/);
  });
});

describe('forge worker list / check', () => {
  it('lists workers', async () => {
    const run = await forge(['worker', 'list'], await temp.make(), fakeRegistry(new FakeWorker()));
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /fake \(alias: alias\) — Fake Worker/);
  });

  it('checks an available worker', async () => {
    const run = await forge(['worker', 'check', 'fake'], await temp.make(), fakeRegistry(new FakeWorker()));
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /Fake Worker \(fake\): available/);
  });

  it('checks an unavailable worker', async () => {
    const run = await forge(['worker', 'check', 'fake'], await temp.make(), fakeRegistry(new FakeWorker(undefined, { available: false })));
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /NOT available/);
    assert.match(run.stdout, /\[FAIL\] executable: not found on PATH/);
  });

  it('rejects unknown subcommands', async () => {
    const run = await forge(['worker', 'loop'], await temp.make(), fakeRegistry(new FakeWorker()));
    assert.equal(run.exitCode, 2);
  });

  it('lists the built-in Claude worker by default', async () => {
    const stdout = new CapturingWriter();
    const exitCode = await runCli(['worker', 'list'], {
      stdout,
      stderr: new CapturingWriter(),
      env: {},
      cwd: await temp.make(),
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
    });
    assert.equal(exitCode, 0);
    assert.match(stdout.text, /claude-code \(alias: claude\) — Claude Code/);
  });
});

describe('project status with worker runs', () => {
  it('summarizes recorded worker runs', async () => {
    const project = await projectWith();
    await forge(['worker', 'run', 'fake', '--task', 't'], project.layout.root, fakeRegistry(new FakeWorker()));
    const run = await forge(['project', 'status'], project.layout.root, fakeRegistry(new FakeWorker()));
    assert.match(run.stdout, /Worker runs:\s+1 \(last: fake success at /);
  });
});
