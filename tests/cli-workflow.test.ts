import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { silentLogger } from '../src/logging/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import type { WorkerRegistry } from '../src/workers/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs, testRunner } from './fixtures.ts';
import { FakeWorker, createTestProject } from './worker-fixtures.ts';

/** Like the built-in registry: `claude` is an alias of the `claude-code` worker. */
function claudeRegistry(worker: FakeWorker): WorkerRegistry {
  return {
    list: () => [{ id: worker.id, aliases: ['claude'], displayName: worker.displayName }],
    create: (name) => (name === 'claude' || name === worker.id ? worker : undefined),
  };
}

const temp = new TempDirs();
after(() => temp.cleanup());

interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cli(project: LoadedProject, workers: WorkerRegistry = claudeRegistry(new FakeWorker(undefined, { id: 'claude-code' }))) {
  return async (...argv: string[]): Promise<CliRun> => {
    const stdout = new CapturingWriter();
    const stderr = new CapturingWriter();
    const context: CliContext = {
      stdout,
      stderr,
      env: {},
      cwd: project.layout.root,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
      workers,
    };
    const exitCode = await runCli(argv, context);
    return { exitCode, stdout: stdout.text, stderr: stderr.text };
  };
}

/** A project with milestone 1 containing A and B (B depends on A). */
async function projectWithTasks() {
  const project = await createTestProject(temp);
  const worker = new FakeWorker(async () => ({ summary: 'Implemented A.' }), { id: 'claude-code' });
  const forge = cli(project, claudeRegistry(worker));
  assert.equal((await forge('milestone', 'add', '--title', 'Foundation')).exitCode, 0);
  assert.equal((await forge('task', 'add', '--milestone', '1', '--title', 'Task A', '--instruction', 'Build A')).exitCode, 0);
  const b = await forge('task', 'add', '--milestone', '1', '--title', 'Task B', '--instruction', 'Build B', '--depends-on', '1.1');
  assert.equal(b.exitCode, 0, b.stderr);
  return { project, worker, forge };
}

describe('forge milestone', () => {
  it('adds, lists, and shows milestones', async () => {
    const project = await createTestProject(temp);
    const forge = cli(project);

    const added = await forge('milestone', 'add', '--title', 'Foundation', '--description', 'Core pieces');
    assert.equal(added.exitCode, 0);
    assert.match(added.stdout, /Added milestone 1: Foundation \([0-9a-f-]{36}\)/);
    await forge('milestone', 'add', '--title', 'Polish');

    const list = await forge('milestone', 'list');
    assert.match(list.stdout, /#\s+ID\s+STATUS\s+DONE\s+TITLE/);
    assert.match(list.stdout, /1\s+[0-9a-f]{8}\s+pending\s+0\/0\s+Foundation\n2\s+[0-9a-f]{8}\s+pending\s+0\/0\s+Polish/);

    const show = await forge('milestone', 'show', '1');
    assert.match(show.stdout, /Milestone 1: Foundation/);
    assert.match(show.stdout, /Description: Core pieces/);
    assert.match(show.stdout, /No tasks yet\./);
  });

  it('refuses to complete a milestone with unfinished tasks', async () => {
    const { forge } = await projectWithTasks();
    const run = await forge('milestone', 'complete', '1');
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /cannot be completed: 2 task\(s\) are not finished/);
  });

  it('reports usage errors', async () => {
    const project = await createTestProject(temp);
    const forge = cli(project);
    assert.equal((await forge('milestone')).exitCode, 2);
    assert.equal((await forge('milestone', 'add')).exitCode, 2);
    assert.equal((await forge('milestone', 'show')).exitCode, 2);
    assert.equal((await forge('milestone', 'show', '7')).exitCode, 1);
  });
});

describe('forge task', () => {
  it('adds tasks with dependencies and lists them with conditions', async () => {
    const { forge } = await projectWithTasks();
    const list = await forge('task', 'list');
    assert.match(list.stdout, /KEY\s+ID\s+CONDITION\s+TRIES\s+TITLE\s+DEPENDS ON/);
    assert.match(list.stdout, /1\.1\s+[0-9a-f]{8}\s+ready\s+0\/3\s+Task A\n/);
    assert.match(list.stdout, /1\.2\s+[0-9a-f]{8}\s+waiting\s+0\/3\s+Task B\s+after 1\.1/);
  });

  it('accepts multiple dependencies, repeated or comma-separated', async () => {
    const { forge } = await projectWithTasks();
    const c = await forge('task', 'add', '--milestone', '1', '--title', 'C', '--instruction', 'x', '--depends-on', '1.1,1.2');
    assert.equal(c.exitCode, 0, c.stderr);
    const d = await forge('task', 'add', '--milestone', '1', '--title', 'D', '--instruction', 'x', '--depends-on', '1.1', '--depends-on', '1.3');
    assert.equal(d.exitCode, 0, d.stderr);
    assert.match((await forge('task', 'show', '1.4')).stdout, /Depends on:\n\s+1\.1\s+ready\s+Task A\n\s+1\.3\s+waiting\s+C/);
  });

  it('shows only runnable tasks in `task ready`', async () => {
    const { forge } = await projectWithTasks();
    const ready = await forge('task', 'ready');
    assert.match(ready.stdout, /1\.1\s+\S+\s+ready/);
    assert.doesNotMatch(ready.stdout, /1\.2/);
  });

  it('runs one task, reports awaiting validation, and starts nothing else', async () => {
    const { project, worker, forge } = await projectWithTasks();
    const run = await forge('task', 'run', '1.1', '--timeout', '120');

    assert.equal(run.exitCode, 0, run.stderr);
    assert.match(run.stderr, /Forge is invoking AI worker "Fake Worker" \(claude-code\) for ONE task\./);
    assert.match(run.stderr, /Task:\s+1\.1 Task A/);
    assert.match(run.stderr, /Attempt:\s+1 of 3/);
    assert.match(run.stderr, /read-only/);
    assert.match(run.stdout, /Outcome:\s+success/);
    assert.match(run.stdout, /Task 1\.1 is now awaiting-validation \(attempt 1 of 3\)/);
    assert.match(run.stdout, /not proof the work is correct/);
    assert.match(run.stdout, /Forge did not start any other task\./);
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0]!.timeoutMs, 120_000);
    assert.equal(worker.requests[0]!.projectId, project.project.id);
  });

  it('accepts a task and reports newly runnable tasks without starting them', async () => {
    const { worker, forge } = await projectWithTasks();
    await forge('task', 'run', '1.1');
    const accept = await forge('task', 'accept', '1.1', '--note', 'reviewed');
    assert.equal(accept.exitCode, 0);
    assert.match(accept.stdout, /Task 1\.1 accepted \(succeeded\)\.\nRunnable now: 1\.2 \(nothing was started\)\./);
    assert.equal(worker.requests.length, 1);
  });

  it('rejects a task with a reason and shows it as retryable', async () => {
    const { forge } = await projectWithTasks();
    await forge('task', 'run', '1.1');
    assert.equal((await forge('task', 'reject', '1.1')).exitCode, 2, '--reason is required');
    const reject = await forge('task', 'reject', '1.1', '--reason', 'Missing tests');
    assert.match(reject.stdout, /Task 1\.1 rejected: now retryable \(2 attempt\(s\) remaining\)/);
    const show = await forge('task', 'show', '1.1');
    assert.match(show.stdout, /#1 rejected\s+claude-code read-only/);
    assert.match(show.stdout, /note: Missing tests/);
  });

  it('refuses to accept a task that never ran', async () => {
    const { forge } = await projectWithTasks();
    const accept = await forge('task', 'accept', '1.2');
    assert.equal(accept.exitCode, 1);
    assert.match(accept.stderr, /only a task awaiting validation/);
  });

  it('refuses to run a blocked task', async () => {
    const { worker, forge } = await projectWithTasks();
    const run = await forge('task', 'run', '1.2');
    assert.equal(run.exitCode, 1);
    assert.match(run.stderr, /not runnable: waiting for "Task A" to succeed/);
    assert.equal(worker.requests.length, 0);
  });

  it('reports a failed execution with exit code 1', async () => {
    const project = await createTestProject(temp);
    const failing = new FakeWorker(async () => ({ outcome: 'failed', summary: null, diagnostics: ['compile error'] }), { id: 'claude-code' });
    const forge = cli(project, claudeRegistry(failing));
    await forge('milestone', 'add', '--title', 'M');
    await forge('task', 'add', '--milestone', '1', '--title', 'T', '--instruction', 'x', '--max-attempts', '1');
    const run = await forge('task', 'run', '1.1');
    assert.equal(run.exitCode, 1);
    assert.match(run.stdout, /Outcome:\s+failed/);
    assert.match(run.stdout, /now exhausted \(attempt 1 of 1\)/);
  });

  it('cancels a task and blocks its dependents', async () => {
    const { forge } = await projectWithTasks();
    const cancel = await forge('task', 'cancel', '1.1', '--reason', 'Not needed');
    assert.equal(cancel.exitCode, 0);
    assert.match((await forge('task', 'list')).stdout, /1\.1\s+\S+\s+cancelled[\s\S]*1\.2\s+\S+\s+blocked/);
  });

  it('refuses recovery of a task that is not running', async () => {
    const { forge } = await projectWithTasks();
    const recover = await forge('task', 'recover', '1.1');
    assert.equal(recover.exitCode, 1);
    assert.match(recover.stderr, /only an interrupted running task needs recovery/);
  });

  it('resolves short IDs and rejects unknown references', async () => {
    const { forge } = await projectWithTasks();
    const list = await forge('task', 'list');
    const shortA = /1\.1\s+([0-9a-f]{8})/.exec(list.stdout)![1]!;
    assert.match((await forge('task', 'show', shortA)).stdout, /Task 1\.1: Task A/);
    assert.match((await forge('task', 'show', shortA.slice(0, 4).toUpperCase())).stdout, /Task 1\.1/);
    const unknown = await forge('task', 'show', 'zzzz');
    assert.equal(unknown.exitCode, 1);
    assert.match(unknown.stderr, /No task matches "zzzz"/);
    assert.match((await forge('task', 'show', 'ab')).stderr, /too short/);
  });

  it('rejects an unknown worker and invalid options', async () => {
    const { forge } = await projectWithTasks();
    assert.equal((await forge('task', 'run', '1.1', '--worker', 'codex')).exitCode, 2);
    assert.equal((await forge('task', 'run', '1.1', '--timeout', '0')).exitCode, 2);
    assert.equal((await forge('task', 'run')).exitCode, 2);
    assert.equal((await forge('task', 'add', '--title', 'x')).exitCode, 2);
    assert.equal((await forge('task', 'add', '--milestone', '1', '--title', 'x', '--instruction', 'y', '--max-attempts', 'lots')).exitCode, 2);
    assert.equal((await forge('task', 'frobnicate')).exitCode, 2);
  });

  it('requires a registered project', async () => {
    const dir = await temp.make('forge-no-project-');
    const stderr = new CapturingWriter();
    const exitCode = await runCli(['task', 'list'], {
      stdout: new CapturingWriter(),
      stderr,
      env: {},
      cwd: dir,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
    });
    assert.equal(exitCode, 1);
    assert.match(stderr.text, /no Forge project found/);
  });
});

describe('forge project status with workflow state', () => {
  it('summarizes milestones, tasks, runnable work, and what needs attention', async () => {
    const { forge } = await projectWithTasks();
    await forge('task', 'run', '1.1');
    const status = await forge('project', 'status');
    assert.match(status.stdout, /Milestones:\s+1 \(active 1\)/);
    assert.match(status.stdout, /Tasks:\s+2 \(waiting 1, awaiting-validation 1\)/);
    assert.match(status.stdout, /Runnable:\s+0/);
    assert.match(status.stdout, /Attention:\s+1 awaiting validation/);
  });
});

describe('persistence across Forge processes', () => {
  it('reads the workflow back in a fresh process', async () => {
    const { project, forge } = await projectWithTasks();
    await forge('task', 'run', '1.1');
    await forge('task', 'accept', '1.1');

    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
    const result = await testRunner.run({ command: process.execPath, args: [entry, 'task', 'ready'], cwd: project.layout.root });
    assert.equal(result.outcome, 'success', result.stderr);
    assert.match(result.stdout, /1\.2\s+[0-9a-f]{8}\s+ready\s+0\/3\s+Task B/);
    assert.doesNotMatch(result.stdout, /^1\.1\s/m, 'the accepted task is no longer listed as ready');
  });
});
