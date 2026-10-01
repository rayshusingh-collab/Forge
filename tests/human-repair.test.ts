import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import { deriveAudit } from '../src/control/audit.ts';
import { ProcessRunner } from '../src/execution/index.ts';
import { silentLogger } from '../src/logging/index.ts';
import { buildPolicy, decideNext } from '../src/orchestration/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { TaskEngine, deriveWorkflow } from '../src/tasks/index.ts';
import type { ExecutorLiveness } from '../src/tasks/index.ts';
import { ValidationProfileStore, normalizeCheck } from '../src/validation/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { createRegisteredRepo, git, nodeCheck, write } from './git-fixtures.ts';
import { FakeWorker } from './worker-fixtures.ts';

/**
 * `forge task accept-repair`: a human repairs an EXHAUSTED task by hand and
 * Forge accepts it only on fresh evidence (required validation passing now,
 * attributable in-scope changes), recording it as a human repair. Found in a
 * real trial: a task exhausted its attempts on a bad dependency version, a
 * human fixed it and `forge validation run` passed, but nothing could unblock
 * the plan.
 */

const temp = new TempDirs();
after(() => temp.cleanup());
const runner = new ProcessRunner({ defaultTimeoutMs: 60_000, killGraceMs: 300 });

const ORIGINAL = 'export const add = (a, b) => a + b;\n';
const BROKEN = `${ORIGINAL}// multiply: TODO\n`;
const MULTIPLY = `${ORIGINAL}export const multiply = (a, b) => a * b;\n`;
const HAS_MULTIPLY = nodeCheck('has-multiply', "require('fs').readFileSync('src/math.js','utf8').includes('export const multiply')");
const REASON = 'Pinned a compatible version by hand; checks pass';

interface Setup {
  readonly project: LoadedProject;
  readonly engine: TaskEngine;
  readonly root: string;
  readonly profiles: ValidationProfileStore;
}

/** A committed repo; task 1.1 (2 attempts) and task 1.2, which depends on it. */
async function setup(options: { readonly checks?: ReturnType<typeof nodeCheck>[]; readonly liveness?: ExecutorLiveness } = {}): Promise<Setup> {
  const project = await createRegisteredRepo(temp, { 'src/math.js': ORIGINAL, 'README.md': '# Demo\n' });
  const profiles = new ValidationProfileStore(project.layout);
  for (const check of options.checks ?? [HAS_MULTIPLY]) {
    await profiles.addCheck(normalizeCheck(check));
  }
  const engine = new TaskEngine({
    project,
    runner,
    evidenceDirectory: await temp.make('forge-evidence-'),
    ...(options.liveness === undefined ? {} : { liveness: options.liveness }),
  });
  await engine.addMilestone({ title: 'M1' });
  await engine.addTask({ milestone: '1', title: 'Add multiply', instruction: 'Add multiply(a,b) to src/math.js', maxAttempts: 2 });
  await engine.addTask({ milestone: '1', title: 'Document it', instruction: 'Document multiply', dependsOn: ['1.1'] });
  return { project, engine, root: project.layout.root, profiles };
}

function worker(root: string, files: Readonly<Record<string, string>>, also: () => Promise<void> = async () => undefined): FakeWorker {
  return new FakeWorker(async () => {
    for (const [path, content] of Object.entries(files)) {
      await write(root, path, content);
    }
    await also();
    return { summary: 'Done. All checks pass.' };
  });
}

/** Two attempts that fail required validation: the task is exhausted. */
async function exhaust(s: Setup): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const outcome = await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN, 'src/helper.js': `// try ${i}\n` }), access: 'edit', timeoutMs: 60_000 });
    assert.equal(outcome.task?.lastAttempt?.outcome, 'validation-failed');
  }
  assert.equal((await s.engine.view()).task((await s.engine.load()).tasks[0]!.id)!.condition, 'exhausted');
}

async function taskRecord(s: Setup, index = 0) {
  return (await s.engine.load()).tasks[index]!;
}

describe('accept-repair: an exhausted task repaired by a human', () => {
  it('accepts it on fresh passing validation, records a HUMAN repair, keeps every attempt, and unblocks dependents', async () => {
    const s = await setup();
    await exhaust(s);
    const before = await taskRecord(s);
    const head = (await git(s.root, 'rev-parse', 'HEAD')).trim();
    assert.deepEqual((await s.engine.view()).runnable, [], 'the dependent task is blocked while 1.1 is exhausted');

    await write(s.root, 'src/math.js', MULTIPLY); // the human's repair
    const outcome = await s.engine.acceptRepair('1.1', { reason: REASON });

    assert.equal(outcome.accepted, true);
    assert.equal(outcome.validation.status, 'passed');
    const after = await taskRecord(s);
    assert.equal(after.status, 'succeeded');
    assert.deepEqual(after.attempts, before.attempts, 'attempt history is untouched: both attempts keep their failed outcome');
    assert.deepEqual(after.attempts.map((attempt) => attempt.outcome), ['validation-failed', 'validation-failed']);
    const repair = after.humanRepair!;
    assert.deepEqual([repair.by, repair.afterAttempt, repair.reason, repair.acknowledgedViolation, repair.commit], ['human', 2, REASON, false, null]);
    assert.equal(repair.validation.checks.find((check) => check.id === 'has-multiply')?.status, 'passed', 'validation was run again now');
    assert.deepEqual(repair.changes.files.map((file) => `${file.change} ${file.path} ${file.attribution}`), ['added src/helper.js task', 'modified src/math.js task']);

    const view = await s.engine.view();
    assert.deepEqual(view.runnable.map((task) => task.key), ['1.2'], 'the dependent task is runnable');
    assert.equal(view.task(after.id)!.attemptsUsed, 2, 'no attempt was consumed or added');
    assert.equal((await git(s.root, 'rev-parse', 'HEAD')).trim(), head, 'nothing was committed');

    const audit = deriveAudit(await s.engine.load(), view);
    assert.ok(audit.some((event) => event.kind === 'human repair accepted' && event.subject === '1.1 (human repair)' && event.detail.includes(REASON)));
  });

  it('refuses when required validation fails now, recording nothing', async () => {
    const s = await setup();
    await exhaust(s);
    const before = await s.engine.load();
    await write(s.root, 'src/math.js', `${ORIGINAL}// still broken\n`);
    const outcome = await s.engine.acceptRepair('1.1', { reason: REASON });
    assert.equal(outcome.accepted, false);
    assert.equal(outcome.validation.status, 'failed');
    const after = await s.engine.load();
    assert.deepEqual(after.tasks, before.tasks, 'task state is unchanged');
    assert.equal(deriveWorkflow(after).task(after.tasks[0]!.id)!.condition, 'exhausted');
  });

  it('refuses when no validation checks are configured', async () => {
    const s = await setup();
    await exhaust(s);
    await s.profiles.removeCheck('has-multiply');
    await write(s.root, 'src/math.js', MULTIPLY);
    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /No required validation checks are configured/);
    assert.equal((await taskRecord(s)).status, 'failed');
  });

  it('does not let optional checks substitute for required ones', async () => {
    const s = await setup();
    await exhaust(s);
    await s.profiles.removeCheck('has-multiply');
    await s.profiles.addCheck(normalizeCheck(nodeCheck('lint', 'true', { required: false })));
    await write(s.root, 'src/math.js', MULTIPLY);
    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /optional checks do not count/);

    // And a passing optional check never outweighs a failing required one.
    await s.profiles.addCheck(normalizeCheck(nodeCheck('needs-divide', "require('fs').readFileSync('src/math.js','utf8').includes('divide')")));
    const outcome = await s.engine.acceptRepair('1.1', { reason: REASON });
    assert.equal(outcome.accepted, false);
    assert.equal((await taskRecord(s)).status, 'failed');
  });

  it('requires a reason', async () => {
    const s = await setup();
    await exhaust(s);
    await write(s.root, 'src/math.js', MULTIPLY);
    await assert.rejects(s.engine.acceptRepair('1.1', { reason: '   ' }), /reason is required/);
  });
});

describe('accept-repair: only when it is safe', () => {
  it('refuses a task that still has attempts (retry it instead) and a pending task', async () => {
    const s = await setup();
    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /is ready; only an exhausted task/);
    await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN }), access: 'edit', timeoutMs: 60_000 });
    await write(s.root, 'src/math.js', MULTIPLY);
    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /is retryable; .*retry it with `forge task run 1\.1`/);
  });

  it('cannot interleave with a running execution (the state lease is held)', async () => {
    const s = await setup();
    await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN }), access: 'edit', timeoutMs: 60_000 });
    let concurrent: unknown;
    const busy = worker(s.root, { 'src/math.js': BROKEN }, async () => {
      concurrent = await s.engine.acceptRepair('1.1', { reason: REASON }).then(
        () => 'accepted',
        (error: unknown) => error,
      );
    });
    await s.engine.runTask('1.1', { worker: busy, access: 'edit', timeoutMs: 60_000 });
    assert.ok(concurrent instanceof Error, 'refused while the task was running');
    assert.match(concurrent.message, /lock|running/i);
    assert.notEqual((await taskRecord(s)).status, 'succeeded');
  });

  it('refuses a running or interrupted execution', async () => {
    let snapshot = '';
    const s = await setup();
    await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN }), access: 'edit', timeoutMs: 60_000 });
    // Capture state as it was mid-run, then put it back: a Forge process that died while running.
    const crash = worker(s.root, { 'src/math.js': BROKEN }, async () => {
      snapshot = await readFile(s.project.layout.stateFile, 'utf8');
    });
    await s.engine.runTask('1.1', { worker: crash, access: 'edit', timeoutMs: 60_000 });
    await writeFile(s.project.layout.stateFile, snapshot);
    await write(s.root, 'src/math.js', MULTIPLY);

    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /is running; only an exhausted task/);
    const dead = new TaskEngine({ project: s.project, runner, liveness: () => false });
    await assert.rejects(dead.acceptRepair('1.1', { reason: REASON }), /is interrupted; .*run `forge task recover 1\.1` first/);
  });

  it('refuses while an orchestration run controls the project', async () => {
    const s = await setup();
    await exhaust(s);
    await write(s.root, 'src/math.js', MULTIPLY);
    await writeFile(s.project.layout.orchestrationLockFile, '{}');
    try {
      await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /orchestration run .* controls this project/);
    } finally {
      await unlink(s.project.layout.orchestrationLockFile);
    }
    assert.equal((await s.engine.acceptRepair('1.1', { reason: REASON })).accepted, true);
  });

  it('never silently converts an integrity violation: it must be acknowledged, and is recorded as such', async () => {
    const s = await setup();
    await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN }), access: 'edit', timeoutMs: 60_000 });
    const tamper = worker(s.root, { 'src/math.js': BROKEN, '.forge/junk.json': '{}' });
    const violated = await s.engine.runTask('1.1', { worker: tamper, access: 'edit', timeoutMs: 60_000 });
    assert.equal(violated.task?.lastAttempt?.outcome, 'integrity-violation');
    assert.equal(violated.task?.condition, 'exhausted');
    await write(s.root, 'src/math.js', MULTIPLY);

    await assert.rejects(s.engine.acceptRepair('1.1', { reason: REASON }), /integrity-violation.*--acknowledge-integrity-violation/s);
    assert.equal((await taskRecord(s)).status, 'failed');

    const outcome = await s.engine.acceptRepair('1.1', { reason: REASON, acknowledgeIntegrityViolation: true });
    assert.equal(outcome.accepted, true);
    const task = await taskRecord(s);
    assert.equal(task.humanRepair?.acknowledgedViolation, true);
    assert.equal(task.attempts.at(-1)?.outcome, 'integrity-violation', 'the violation stays in the history');
  });

  it('refuses when HEAD moved since the task began, even with acknowledgement', async () => {
    const s = await setup();
    await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': BROKEN }), access: 'edit', timeoutMs: 60_000 });
    const committer = worker(s.root, {}, async () => {
      await git(s.root, 'commit', '-q', '--allow-empty', '-m', 'sneaky');
    });
    const violated = await s.engine.runTask('1.1', { worker: committer, access: 'edit', timeoutMs: 60_000 });
    assert.equal(violated.task?.lastAttempt?.outcome, 'scope-violation');
    await write(s.root, 'src/math.js', MULTIPLY);
    await assert.rejects(
      s.engine.acceptRepair('1.1', { reason: REASON, acknowledgeIntegrityViolation: true }),
      /HEAD or the current branch changed during the task; the repair cannot be accepted/,
    );
    assert.equal((await taskRecord(s)).status, 'failed');
  });

  it('leaves override semantics unchanged: an exhausted task cannot be overridden', async () => {
    const s = await setup();
    await exhaust(s);
    await assert.rejects(s.engine.overrideTask('1.1', 'just accept it'), /is failed; only a task awaiting validation can be overridden/);
  });
});

describe('accept-repair: Git attribution and safe commit', () => {
  it('never claims a previous task\'s uncommitted work: shared files stay mixed and are not committed', async () => {
    const s = await setup();
    // 1.1 succeeds but is left uncommitted (as in the real trial).
    const first = await s.engine.runTask('1.1', { worker: worker(s.root, { 'src/math.js': MULTIPLY, 'test/a.test.js': 'a\n' }), access: 'edit', timeoutMs: 60_000 });
    assert.equal(first.task?.task.status, 'succeeded');
    await s.profiles.addCheck(normalizeCheck(nodeCheck('has-docs', "require('fs').existsSync('docs/multiply.md') && require('fs').readFileSync('src/math.js','utf8').includes('// documented')")));
    for (let i = 0; i < 3; i++) {
      await s.engine.runTask('1.2', { worker: worker(s.root, { 'src/math.js': `${MULTIPLY}// half done ${i}\n`, 'docs/multiply.md': `draft ${i}\n` }), access: 'edit', timeoutMs: 60_000 });
    }
    const view = await s.engine.view();
    assert.equal(view.tasks[1]!.condition, 'exhausted');

    await write(s.root, 'src/math.js', `${MULTIPLY}// documented\n`);
    const outcome = await s.engine.acceptRepair('1.2', { reason: REASON });
    assert.equal(outcome.accepted, true);
    assert.deepEqual(
      outcome.changes.files.map((file) => `${file.path} ${file.attribution}`),
      ['docs/multiply.md task', 'src/math.js mixed'],
      "1.1's untouched files are not claimed; the shared file is mixed",
    );
    await assert.rejects(s.engine.commitTask('1.2'), /already had uncommitted changes before the task.*commit them yourself/);
  });

  it('commits only through the existing safe-commit rules, exactly the attributed paths, labelled as a human repair', async () => {
    const s = await setup();
    await write(s.root, 'README.md', '# Demo\n\nmy own uncommitted notes\n'); // unrelated user work
    await exhaust(s);
    await write(s.root, 'src/math.js', MULTIPLY);
    await s.engine.acceptRepair('1.1', { reason: REASON });

    // Safe-commit re-verification is unchanged: drift after acceptance is refused.
    await write(s.root, 'src/math.js', `${MULTIPLY}// later edit\n`);
    await assert.rejects(s.engine.commitTask('1.1'), /src\/math\.js changed after the task was validated/);
    await write(s.root, 'src/math.js', MULTIPLY);

    const committed = await s.engine.commitTask('1.1');
    assert.deepEqual([...committed.paths].sort(), ['src/helper.js', 'src/math.js']);
    assert.match(committed.message, /^forge: complete task 1\.1 - Add multiply \(human repair\)\n\nForge-Task: .+\nForge-Human-Repair: after attempt 2\nForge-Validation: passed \(has-multiply\)/);
    assert.equal((await git(s.root, 'status', '--porcelain')).trim(), 'M README.md', 'unrelated user work was left uncommitted');
    const task = await taskRecord(s);
    assert.equal(task.humanRepair?.commit?.sha, committed.commit.sha);
    assert.deepEqual(task.attempts.map((attempt) => attempt.commit), [null, null], 'attempts are still untouched');
    await assert.rejects(s.engine.commitTask('1.1'), /already committed/);
  });

  it('is never auto-committed by an orchestration run, which simply continues with the dependent task', async () => {
    const s = await setup();
    await exhaust(s);
    await write(s.root, 'src/math.js', MULTIPLY);
    await s.engine.acceptRepair('1.1', { reason: REASON });
    const state = await s.engine.load();
    const next = decideNext(state, deriveWorkflow(state), buildPolicy({ access: 'edit', autoCommit: true }, { workerTimeoutMs: 60_000 }), {
      runId: 'r',
      tasksStarted: new Set(),
      reviewsThisRun: new Set(),
    });
    assert.deepEqual(next, { kind: 'execute', taskId: state.tasks[1]!.id });
  });
});

describe('human repair state invariants', () => {
  it('refuses to load a forged or inconsistent human repair', async () => {
    const s = await setup();
    await exhaust(s);
    await write(s.root, 'src/math.js', MULTIPLY);
    await s.engine.acceptRepair('1.1', { reason: REASON });
    const valid = await readFile(s.project.layout.stateFile, 'utf8');
    const tamper = async (change: (task: Record<string, any>) => void, pattern: RegExp) => {
      const doc = JSON.parse(valid);
      change(doc.tasks[0]);
      await writeFile(s.project.layout.stateFile, JSON.stringify(doc));
      await assert.rejects(s.engine.load(), pattern);
    };
    await tamper((task) => (task.humanRepair.validation.status = 'failed'), /must be a passed validation of at least one required check/);
    await tamper((task) => (task.humanRepair.validation.checks = task.humanRepair.validation.checks.map((check: Record<string, unknown>) => ({ ...check, required: false }))), /at least one required check/);
    await tamper((task) => (task.maxAttempts = 3), /must be the last attempt of a task that used all its attempts/);
    await tamper((task) => (task.humanRepair.acknowledgedViolation = true), /acknowledgedViolation/);
    await tamper((task) => (task.humanRepair = null), /"succeeded" is inconsistent with its attempts/);
    await writeFile(s.project.layout.stateFile, valid);
    assert.equal((await s.engine.load()).tasks[0]!.status, 'succeeded');
  });
});

describe('forge task accept-repair (CLI)', () => {
  async function cli(s: Setup, ...args: string[]) {
    const stdout = new CapturingWriter();
    const stderr = new CapturingWriter();
    const code = await runCli(args, {
      stdout,
      stderr,
      env: {},
      cwd: s.root,
      version: 'test',
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: silentLogger,
    });
    return { code, out: stdout.text, err: stderr.text };
  }

  it('reports the evidence and the human-repair decision; show and audit say it was a human repair', async () => {
    const s = await setup();
    await exhaust(s);
    assert.equal((await cli(s, 'task', 'accept-repair', '1.1')).code, 2, '--reason is required');

    await write(s.root, 'src/math.js', `${ORIGINAL}// nope\n`);
    const refused = await cli(s, 'task', 'accept-repair', '1.1', '--reason', REASON);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /has-multiply\s+FAIL/);
    assert.match(refused.out, /Forge decision: REFUSED — required validation failed\. Nothing was recorded; the task stays exhausted\./);

    await write(s.root, 'src/math.js', MULTIPLY);
    const accepted = await cli(s, 'task', 'accept-repair', '1.1', '--reason', REASON);
    assert.equal(accepted.code, 0, accepted.err);
    assert.match(accepted.out, /has-multiply\s+PASS/);
    assert.match(accepted.out, /Forge decision: SUCCEEDED \(HUMAN REPAIR after attempt 2; not a worker success\)/);
    assert.match(accepted.out, /Commit: not committed\. Optional, local only: forge task commit 1\.1/);
    assert.match(accepted.out, /Runnable now: 1\.2 \(nothing was started\)/);

    const show = await cli(s, 'task', 'show', '1.1');
    assert.match(show.out, /HUMAN REPAIR: accepted .* after attempt 2 \(no worker; the attempts below keep their outcomes\)/);
    assert.match(show.out, /#1 validation-failed[\s\S]*#2 validation-failed/);
    const audit = await cli(s, 'audit');
    assert.match(audit.out, /human repair accepted\s+1\.1 \(human repair\)\s+by a human after attempt 2; validation passed/);
  });
});
