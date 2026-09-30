import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import { WorkflowError } from '../src/core/errors.ts';
import { ProcessRunner } from '../src/execution/index.ts';
import { silentLogger } from '../src/logging/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { TaskEngine } from '../src/tasks/index.ts';
import type { RunTaskOptions } from '../src/tasks/index.ts';
import { ValidationProfileStore, normalizeCheck } from '../src/validation/index.ts';
import type { WorkerResult } from '../src/workers/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { createRegisteredRepo, git, nodeCheck, write } from './git-fixtures.ts';
import { FakeWorker } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const runner = new ProcessRunner({ defaultTimeoutMs: 60_000, killGraceMs: 300 });

interface Setup {
  readonly project: LoadedProject;
  readonly engine: TaskEngine;
  readonly root: string;
}

/** A committed repo with `src/math.js`, one milestone, Task A and Task B (depends on A). */
async function setup(checks: ReturnType<typeof nodeCheck>[] = [nodeCheck('has-multiply', "require('fs').readFileSync('src/math.js','utf8').includes('multiply')")]): Promise<Setup> {
  const project = await createRegisteredRepo(temp, { 'src/math.js': 'export const add = (a, b) => a + b;\n', 'README.md': '# Demo\n' });
  const store = new ValidationProfileStore(project.layout);
  for (const check of checks) {
    await store.addCheck(normalizeCheck(check));
  }
  const engine = new TaskEngine({ project, runner, evidenceDirectory: await temp.make('forge-evidence-') });
  await engine.addMilestone({ title: 'M1' });
  await engine.addTask({ milestone: '1', title: 'Add multiply', instruction: 'Add multiply(a,b) to src/math.js' });
  await engine.addTask({ milestone: '1', title: 'Document it', instruction: 'Document multiply', dependsOn: ['1.1'] });
  return { project, engine, root: project.layout.root };
}

/** A worker that edits files in the project, then reports the given result. */
function editingWorker(root: string, files: Readonly<Record<string, string>>, result: Partial<WorkerResult> = {}): FakeWorker {
  return new FakeWorker(async () => {
    for (const [path, content] of Object.entries(files)) {
      await write(root, path, content);
    }
    return { summary: 'Tests pass. Everything is done.', ...result };
  });
}

const MULTIPLY = 'export const add = (a, b) => a + b;\nexport const multiply = (a, b) => a * b;\n';

function edit(worker: FakeWorker, extra: Partial<RunTaskOptions> = {}): RunTaskOptions {
  return { worker, access: 'edit', timeoutMs: 60_000, ...extra };
}

describe('task execution with deterministic validation', () => {
  it('succeeds only when required validation passes, then stops', async () => {
    const { engine, root } = await setup();
    const worker = editingWorker(root, { 'src/math.js': MULTIPLY, 'test/math.test.js': 'ok' });

    const outcome = await engine.runTask('1.1', edit(worker));

    assert.equal(outcome.task?.task.status, 'succeeded');
    assert.equal(outcome.task?.lastAttempt?.outcome, 'validated');
    assert.equal(outcome.run.post?.validation?.status, 'passed');
    assert.deepEqual(
      outcome.run.post?.changes?.files.map((file) => `${file.change} ${file.path} ${file.attribution}`),
      ['modified src/math.js task', 'added test/math.test.js task'],
    );
    const view = await engine.view();
    assert.deepEqual(view.runnable.map((task) => task.key), ['1.2']);
    assert.equal(view.task(view.runnable[0]!.task.id)!.attemptsUsed, 0, 'the next task was not started');
    assert.equal(worker.requests.length, 1);
  });

  it('never treats the worker\'s claim as validation: a required failure fails the task', async () => {
    const { engine, root } = await setup();
    // The worker claims success but does not add multiply.
    const worker = editingWorker(root, { 'src/other.js': 'x' }, { summary: 'Added multiply. All tests pass!' });
    const outcome = await engine.runTask('1.1', edit(worker));
    assert.equal(outcome.task?.task.status, 'failed');
    assert.equal(outcome.task?.lastAttempt?.outcome, 'validation-failed');
    assert.equal(outcome.task?.condition, 'retryable');
    assert.match(outcome.task?.lastAttempt?.note ?? '', /required validation failed: has-multiply failed/);
  });

  it('does not run validation when the worker fails', async () => {
    const { engine, root } = await setup([nodeCheck('marker', "require('fs').writeFileSync('validated.marker','') || true")]);
    const worker = editingWorker(root, { 'src/math.js': MULTIPLY }, { outcome: 'failed', summary: null });
    const outcome = await engine.runTask('1.1', edit(worker));
    assert.equal(outcome.task?.lastAttempt?.outcome, 'failed');
    assert.equal(outcome.task?.lastAttempt?.validation, null);
    await assert.rejects(readFile(join(root, 'validated.marker')), { code: 'ENOENT' });
  });

  it('lets an optional failure pass', async () => {
    const { engine, root } = await setup([
      nodeCheck('has-multiply', "require('fs').readFileSync('src/math.js','utf8').includes('multiply')"),
      nodeCheck('lint', 'false', { required: false }),
    ]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.task?.task.status, 'succeeded');
    assert.deepEqual(outcome.run.post?.validation?.checks.map((check) => check.status), ['passed', 'failed']);
  });

  it('keeps the task awaiting validation when no checks are configured ("no checks" is not "validated")', async () => {
    const { engine, root } = await setup([]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.task?.task.status, 'awaiting-validation');
    assert.match(outcome.task?.lastAttempt?.note ?? '', /no required validation checks are configured/);
    assert.deepEqual((await engine.view()).runnable, [], 'the dependent task stays blocked');

    // Adding checks and validating resolves it deterministically, without a new attempt.
    await new ValidationProfileStore((engine as unknown as { project: LoadedProject }).project.layout).addCheck(
      normalizeCheck(nodeCheck('has-multiply', "require('fs').readFileSync('src/math.js','utf8').includes('multiply')")),
    );
    const validated = await engine.validateTask('1.1');
    assert.equal(validated.task?.task.status, 'succeeded');
    assert.equal(validated.task?.attemptsUsed, 1);
  });

  it('treats only optional checks as no validation', async () => {
    const { engine, root } = await setup([nodeCheck('lint', 'true', { required: false })]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.task?.task.status, 'awaiting-validation');
  });

  it('fails the task when a required check times out', async () => {
    const { engine, root } = await setup([{ ...nodeCheck('hang', 'true'), args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1_000 }]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.task?.lastAttempt?.outcome, 'validation-failed');
    assert.equal(outcome.run.post?.validation?.status, 'timed-out');
  });

  it('leaves the task awaiting validation (never succeeded) when validation is cancelled', async () => {
    const { engine, root } = await setup([{ ...nodeCheck('slow', 'true'), args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60_000 }]);
    const controller = new AbortController();
    const worker = new FakeWorker(async () => {
      await write(root, 'src/math.js', MULTIPLY);
      setTimeout(() => controller.abort(), 500);
      return {};
    });
    const outcome = await engine.runTask('1.1', edit(worker, { signal: controller.signal }));
    assert.equal(outcome.run.post?.validation?.status, 'cancelled');
    assert.equal(outcome.task?.task.status, 'awaiting-validation');
    assert.match(outcome.task?.lastAttempt?.note ?? '', /validation did not complete \(cancelled\)/);
  });

  it('keeps the task awaiting validation on a validation configuration error', async () => {
    const { engine, root } = await setup([{ id: 'broken', executable: 'forge-no-such-tool-7f3a', args: [], cwd: '.', timeoutMs: 5_000, required: true }]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.run.post?.validation?.status, 'configuration-error');
    assert.equal(outcome.task?.task.status, 'awaiting-validation');
  });

  it('lets an integrity violation override passing validation', async () => {
    const { project, engine, root } = await setup();
    // The worker makes the check pass AND rewrites the trusted validation profile.
    const worker = new FakeWorker(async () => {
      await write(root, 'src/math.js', MULTIPLY);
      await writeFile(join(project.layout.forgeDir, 'validation.json'), JSON.stringify({ schemaVersion: 1, checks: [], updatedAt: null }));
      return {};
    });
    const outcome = await engine.runTask('1.1', edit(worker));
    assert.equal(outcome.run.status, 'integrity-violation');
    assert.equal(outcome.task?.task.status, 'failed');
    assert.equal(outcome.task?.lastAttempt?.outcome, 'integrity-violation');
  });

  it('catches validation commands that modify control state, even when they pass', async () => {
    const { engine, root } = await setup([nodeCheck('tamper', "require('fs').writeFileSync('.forge/planted', '') || true")]);
    const outcome = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(outcome.run.status, 'integrity-violation', 'the post-validation integrity check overrides the passing check');
    assert.equal(outcome.task?.task.status, 'failed');
  });

  it('fails a task during which HEAD moved, and requires acknowledgement to retry', async () => {
    const { engine, root } = await setup();
    const worker = new FakeWorker(async () => {
      await write(root, 'src/math.js', MULTIPLY);
      await git(root, 'commit', '-q', '-am', 'worker committed on its own');
      return {};
    });
    const outcome = await engine.runTask('1.1', edit(worker));
    assert.equal(outcome.task?.lastAttempt?.outcome, 'scope-violation');
    assert.match(outcome.task?.lastAttempt?.note ?? '', /HEAD or the current branch changed during the task/);
    assert.equal(outcome.run.post?.validation, null, 'validation does not run after a scope violation');
    await assert.rejects(engine.runTask('1.1', edit(editingWorker(root, {}))), /--acknowledge-integrity-violation/);
  });

  it('refuses to start while the repository has merge conflicts, without consuming an attempt', async () => {
    const { engine, root } = await setup();
    await git(root, 'checkout', '-q', '-b', 'side');
    await write(root, 'README.md', 'side\n');
    await git(root, 'commit', '-q', '-am', 'side');
    await git(root, 'checkout', '-q', '-');
    await write(root, 'README.md', 'main\n');
    await git(root, 'commit', '-q', '-am', 'main');
    await testRunnerMerge(root);
    const worker = editingWorker(root, { 'src/math.js': MULTIPLY });
    await assert.rejects(engine.runTask('1.1', edit(worker)), /unresolved merge conflicts/);
    assert.equal(worker.requests.length, 0);
    assert.equal((await engine.view()).tasks[0]!.attemptsUsed, 0);
  });
});

/** Starts a conflicting merge (expected to exit non-zero), leaving unmerged paths. */
async function testRunnerMerge(root: string): Promise<void> {
  const { testRunner } = await import('./fixtures.ts');
  const result = await testRunner.run({ command: 'git', args: ['merge', '--no-edit', 'side'], cwd: root });
  assert.equal(result.outcome, 'non-zero-exit');
}

describe('retries and attribution', () => {
  it('keeps earlier attempts\' edits attributed to the task, and commits the cumulative change', async () => {
    const { engine, root } = await setup();
    await write(root, 'notes.txt', 'user notes, not part of the task');
    // Attempt 1 writes a helper and a broken math.js; validation fails.
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/helper.js': 'helper', 'src/math.js': 'broken' })));
    assert.equal((await engine.view()).tasks[0]!.condition, 'retryable');

    // Attempt 2 only fixes math.js; the helper from attempt 1 is still the task's.
    const second = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(second.task?.task.status, 'succeeded');
    assert.deepEqual(
      second.run.post?.changes?.files.map((file) => `${file.path}:${file.attribution}`),
      ['src/helper.js:task', 'src/math.js:task'],
    );
    const commit = await engine.commitTask('1.1');
    assert.deepEqual([...commit.paths].sort(), ['src/helper.js', 'src/math.js']);
    assert.equal((await git(root, 'status', '--porcelain')).trim(), '?? notes.txt');
  });

  it('treats a user edit between attempts as the user\'s, and refuses an ambiguous commit', async () => {
    const { engine, root } = await setup();
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': 'broken' })));
    await write(root, 'src/math.js', 'broken, then edited by the user');
    const second = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal(second.task?.task.status, 'succeeded');
    assert.deepEqual(second.run.post?.changes?.files.map((file) => `${file.path}:${file.attribution}`), ['src/math.js:mixed']);
    await assert.rejects(engine.commitTask('1.1'), /already had uncommitted changes/);
  });

  it('records what a failed worker changed and attributes it on the retry', async () => {
    const { engine, root } = await setup();
    const failed = await engine.runTask('1.1', edit(editingWorker(root, { 'src/partial.js': 'half done' }, { outcome: 'failed', summary: null })));
    assert.deepEqual(failed.task?.lastAttempt?.changes?.files.map((file) => file.path), ['src/partial.js']);
    assert.equal(failed.task?.lastAttempt?.validation, null);
    const retry = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.deepEqual(retry.run.post?.changes?.files.map((file) => `${file.path}:${file.attribution}`), ['src/math.js:task', 'src/partial.js:task']);
  });

  it('falls back to a fresh baseline when HEAD moved between attempts', async () => {
    const { engine, root } = await setup();
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/helper.js': 'helper', 'src/math.js': 'broken' })));
    await write(root, 'unrelated.txt', 'x');
    await git(root, 'add', 'unrelated.txt');
    await git(root, 'commit', '-q', '-m', 'user commit between attempts');
    const second = await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    // Earlier edits can no longer be attributed: they count as pre-existing.
    assert.deepEqual(second.run.post?.changes?.files.map((file) => `${file.path}:${file.attribution}`), ['src/math.js:mixed']);
  });
});

describe('override and reject', () => {
  it('overrides only a task awaiting validation, with a recorded reason', async () => {
    const { engine, root } = await setup([]);
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    await assert.rejects(engine.overrideTask('1.1', ' '), /Override reason must not be empty/);
    await engine.overrideTask('1.1', 'verified manually in the browser');
    const task = (await engine.view()).tasks[0]!;
    assert.equal(task.task.status, 'succeeded');
    assert.equal(task.lastAttempt?.outcome, 'overridden');
    assert.equal(task.lastAttempt?.note, 'override: verified manually in the browser');
  });

  it('cannot override a task whose validation failed', async () => {
    const { engine, root } = await setup();
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/other.js': 'x' })));
    await assert.rejects(engine.overrideTask('1.1', 'please'), /is failed; only a task awaiting validation can be overridden/);
  });
});

describe('safe commit', () => {
  async function validated(files: Readonly<Record<string, string>> = { 'src/math.js': MULTIPLY, 'test/math.test.js': 'ok' }) {
    const context = await setup();
    await context.engine.runTask('1.1', edit(editingWorker(context.root, files)));
    return context;
  }

  it('commits exactly the task-attributed files with a deterministic message, and never pushes', async () => {
    const { engine, root } = await validated();
    const before = (await git(root, 'rev-parse', 'HEAD')).trim();

    const outcome = await engine.commitTask('1.1');

    assert.deepEqual([...outcome.paths].sort(), ['src/math.js', 'test/math.test.js']);
    assert.equal((await git(root, 'rev-parse', 'HEAD')).trim(), outcome.commit.sha);
    assert.equal((await git(root, 'rev-parse', 'HEAD~1')).trim(), before);
    const message = await git(root, 'log', '-1', '--format=%B');
    assert.match(message, /^forge: complete task 1\.1 - Add multiply\n\nForge-Task: [0-9a-f-]{36}\nForge-Attempt: 1\nForge-Validation: passed \(has-multiply\)/);
    assert.doesNotMatch(message, /Tests pass/, 'worker output never becomes the commit message');
    const committed = (await git(root, 'show', '--name-only', '--format=', 'HEAD')).trim().split('\n').sort();
    assert.deepEqual(committed, ['src/math.js', 'test/math.test.js']);
    assert.equal((await git(root, 'status', '--porcelain')).trim(), '');
    assert.equal((await git(root, 'remote')).trim(), '');
    assert.equal((await engine.view()).tasks[0]!.lastAttempt?.commit?.sha, outcome.commit.sha);
    await assert.rejects(engine.commitTask('1.1'), /already committed/);
  });

  it('never includes .forge or pre-existing unrelated changes, staged or not', async () => {
    const context = await setup();
    const { engine, root } = context;
    await write(root, 'README.md', '# Demo\nuser edit, unstaged\n');
    await write(root, 'notes.txt', 'untracked user notes');
    await write(root, 'staged-by-user.txt', 'staged');
    await git(root, 'add', 'staged-by-user.txt');

    await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    const outcome = await engine.commitTask('1.1');

    assert.deepEqual(outcome.paths, ['src/math.js']);
    const committed = (await git(root, 'show', '--name-only', '--format=', 'HEAD')).trim();
    assert.equal(committed, 'src/math.js');
    const status = (await git(root, 'status', '--porcelain')).split('\n').filter(Boolean).sort();
    assert.deepEqual(status, [' M README.md', '?? notes.txt', 'A  staged-by-user.txt'], 'user changes are exactly as they were');
  });

  it('refuses to commit a file that already had uncommitted changes (ambiguous attribution)', async () => {
    const { engine, root } = await setup();
    await write(root, 'src/math.js', 'export const add = (a, b) => a + b; // user edit\n');
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    assert.equal((await engine.view()).tasks[0]!.task.status, 'succeeded');
    await assert.rejects(engine.commitTask('1.1'), /already had uncommitted changes before the task/);
    assert.equal((await git(root, 'rev-list', '--count', 'HEAD')).trim(), '1', 'no commit was created');
  });

  it('refuses to commit a failed task or one awaiting validation', async () => {
    const failed = await setup();
    await failed.engine.runTask('1.1', edit(editingWorker(failed.root, { 'src/other.js': 'x' })));
    await assert.rejects(failed.engine.commitTask('1.1'), (error: unknown) => error instanceof WorkflowError && /is failed/.test(error.message));

    const waiting = await setup([]);
    await waiting.engine.runTask('1.1', edit(editingWorker(waiting.root, { 'src/math.js': MULTIPLY })));
    await assert.rejects(waiting.engine.commitTask('1.1'), /is awaiting-validation/);
  });

  it('refuses to commit an overridden (not validated) task', async () => {
    const { engine, root } = await setup([]);
    await engine.runTask('1.1', edit(editingWorker(root, { 'src/math.js': MULTIPLY })));
    await engine.overrideTask('1.1', 'manual');
    await assert.rejects(engine.commitTask('1.1'), /passed deterministic validation/);
  });

  it('refuses when a file changed after validation, or HEAD moved', async () => {
    const drifted = await validated();
    await write(drifted.root, 'src/math.js', `${MULTIPLY}// later edit\n`);
    await assert.rejects(drifted.engine.commitTask('1.1'), /changed after the task was validated/);

    const moved = await validated({ 'src/math.js': MULTIPLY });
    await write(moved.root, 'other.txt', 'x');
    await git(moved.root, 'add', 'other.txt');
    await git(moved.root, 'commit', '-q', '-m', 'user commit');
    await assert.rejects(moved.engine.commitTask('1.1'), /HEAD or the current branch changed/);
  });

  it('refuses when the user staged part of the task change after validation', async () => {
    const { engine, root } = await validated({ 'src/math.js': MULTIPLY });
    await git(root, 'add', 'src/math.js');
    await assert.rejects(engine.commitTask('1.1'), /no longer has the expected, unstaged modified change/);
  });

  it('commits in a repository without any commits yet', async () => {
    const project = await createRegisteredRepo(temp, { 'README.md': 'x' }, { commit: false });
    await new ValidationProfileStore(project.layout).addCheck(normalizeCheck(nodeCheck('ok', 'true')));
    const engine = new TaskEngine({ project, runner });
    await engine.addMilestone({ title: 'M' });
    await engine.addTask({ milestone: '1', title: 'Start', instruction: 'x' });
    await engine.runTask('1.1', edit(editingWorker(project.layout.root, { 'index.js': 'x' })));
    const outcome = await engine.commitTask('1.1');
    assert.deepEqual(outcome.paths, ['index.js']);
    assert.equal((await git(project.layout.root, 'status', '--porcelain')).trim(), '?? README.md', 'the pre-existing untracked file was not committed');
  });
});

describe('forge task run output', () => {
  it('shows worker claim, changes, validation, decision, and next runnable — and starts nothing else', async () => {
    const { project, root } = await setup();
    const worker = editingWorker(root, { 'src/math.js': MULTIPLY });
    const stdout = new CapturingWriter();
    const exitCode = await runCli(['task', 'run', '1.1', '--allow-edits'], {
      stdout,
      stderr: new CapturingWriter(),
      env: {},
      cwd: project.layout.root,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
      workers: {
        list: () => [{ id: worker.id, aliases: ['claude'], displayName: worker.displayName }],
        create: () => worker,
      },
    });
    assert.equal(exitCode, 0);
    assert.match(stdout.text, /Worker's claim \(not evidence\): Tests pass\. Everything is done\./);
    assert.match(stdout.text, /Changes:\s+1 modified, 0 added, 0 deleted/);
    assert.match(stdout.text, /Validation:\n\s+has-multiply\s+PASS/);
    assert.match(stdout.text, /Forge decision: SUCCEEDED/);
    assert.match(stdout.text, /Attempt:\s+1\/3/);
    assert.match(stdout.text, /Next runnable: 1\.2/);
    assert.match(stdout.text, /Nothing else was started\./);
  });
});

