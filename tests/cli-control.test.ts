import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { silentLogger } from '../src/logging/index.ts';
import { TempDirs } from './fixtures.ts';
import { FakeAiProvider, aiRegistry } from './ai-fixtures.ts';
import { createRepo, git, write } from './git-fixtures.ts';
import { CapturingWriter } from './helpers.ts';
import { MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, scriptedReviewer, scriptedWorker } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';
import { FakeWorker, fakeRegistry } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

function cli(cwd: string, extras: Partial<CliContext> = {}) {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const context: CliContext = {
    stdout,
    stderr,
    env: {},
    cwd,
    version: 'test',
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: silentLogger,
    workers: fakeRegistry(new FakeWorker(async () => ({}), { id: 'claude' })),
    aiProviders: aiRegistry(FakeAiProvider.answering('{}', 'claude')),
    ...extras,
  };
  return { stdout, stderr, run: (args: string[]) => runCli(args, context) };
}

/** A project stopped on review concerns, with one pending approval. */
async function stoppedOnConcerns(): Promise<{ setup: OrchestrationSetup; approvalId: string }> {
  const setup = await orchestrationProject(temp);
  const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
  const reviewer = scriptedReviewer([reviewJson([{ severity: 'warning', title: 'Missing negative test' }])]);
  const result = await makeOrchestrator(setup, worker, { review: true, reviewer: reviewer.id }, { reviewer }).run();
  return { setup, approvalId: result.approvalId! };
}

/** Bytes of everything an inspection command must not change. */
async function fingerprint(setup: OrchestrationSetup): Promise<string> {
  const forge = setup.project.layout.forgeDir;
  const files = (await readdir(forge)).sort();
  const forgeBytes = await Promise.all(files.map(async (name) => `${name}:${await readFile(join(forge, name), 'utf8').catch(() => '<dir>')}`));
  const source = await readFile(join(setup.root, 'src/math.js'), 'utf8');
  return [...forgeBytes, source, await git(setup.root, 'status', '--porcelain'), await git(setup.root, 'rev-parse', 'HEAD')].join('\n---\n');
}

describe('forge approval (CLI)', () => {
  it('lists and shows bounded evidence; approve/reject need a reason and are explicit', async () => {
    const { setup, approvalId } = await stoppedOnConcerns();
    const short = approvalId.slice(0, 8);
    const list = cli(setup.root);
    assert.equal(await list.run(['approval', 'list']), 0);
    assert.match(list.stdout.text, new RegExp(`${short}\\s+pending\\s+review-acceptance\\s+1\\.1`));

    const show = cli(setup.root);
    assert.equal(await show.run(['approval', 'show', short]), 0);
    assert.match(show.stdout.text, /Evidence \(bounded summary\):\n {2}- deterministic validation: passed/);
    assert.match(show.stdout.text, /\[warning\] Missing negative test/);
    assert.match(show.stdout.text, /Approving allows: Accept the implementation/);

    const noReason = cli(setup.root);
    assert.equal(await noReason.run(['approval', 'approve', short]), 2);
    assert.match(noReason.stderr.text, /--reason <text> is required/);

    const approve = cli(setup.root);
    assert.equal(await approve.run(['approval', 'approve', short, '--reason', 'Edge case is out of scope']), 0);
    assert.match(approve.stdout.text, /approved by a human/);
    assert.match(approve.stdout.text, /Nothing was executed by this command/);
    const state = await setup.store.load();
    assert.equal(state.approvals[0]!.status, 'approved');
    assert.equal(state.tasks[1]!.attempts.length, 0);

    const again = cli(setup.root);
    assert.equal(await again.run(['approval', 'reject', short, '--reason', 'no']), 1);
    assert.match(again.stderr.text, /is approved; only a pending approval can be rejected/);
  });

  it('refuses to approve a request whose evidence changed, and invalidates it', async () => {
    const { setup, approvalId } = await stoppedOnConcerns();
    const accept = cli(setup.root);
    assert.equal(await accept.run(['task', 'review-accept', '1.1', '--reason', 'decided directly']), 0);
    const approve = cli(setup.root);
    assert.equal(await approve.run(['approval', 'approve', approvalId.slice(0, 8), '--reason', 'ok']), 1);
    assert.match(approve.stderr.text, /no longer matches the evidence .* it was invalidated and NOT approved/);
    assert.equal((await setup.store.load()).approvals[0]!.status, 'invalidated');
  });
});

describe('pause / resume (CLI)', () => {
  it('pause refuses runs; inspection still works; resume needs a reason', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    assert.equal(await cli(setup.root).run(['pause']), 2);
    assert.equal(await cli(setup.root).run(['pause', '--reason', 'Reviewing']), 0);
    const run = cli(setup.root, { workers: fakeRegistry(worker) });
    assert.equal(await run.run(['run', '--allow-edits', '--worker', 'fake']), 1);
    assert.match(run.stderr.text, /preflight failed/);
    assert.match(run.stderr.text, /paused since .*Reviewing/);
    assert.equal(worker.requests.length, 0);
    const taskRun = cli(setup.root, { workers: fakeRegistry(worker) });
    assert.equal(await taskRun.run(['task', 'run', '1.1', '--allow-edits', '--worker', 'fake']), 1);
    assert.match(taskRun.stderr.text, /paused/);
    const status = cli(setup.root);
    assert.equal(await status.run(['status', '--no-providers']), 0);
    assert.match(status.stdout.text, /PAUSED since .* Reviewing/);
    assert.equal(await cli(setup.root).run(['resume']), 2);
    const resume = cli(setup.root);
    assert.equal(await resume.run(['resume', '--reason', 'Done']), 0);
    assert.match(resume.stdout.text, /Nothing was started/);
    assert.equal(worker.requests.length, 0);
  });
});

describe('forge config (CLI)', () => {
  it('shows sources, sets typed values, refuses bad keys/values/secrets, and records changes', async () => {
    const setup = await orchestrationProject(temp);
    const show = cli(setup.root);
    assert.equal(await show.run(['config', 'show']), 0);
    assert.match(show.stdout.text, /run\.maxTasks\s+5\s+default/);
    assert.equal(await cli(setup.root).run(['config', 'set', 'run.maxTasks', '3']), 0);
    const get = cli(setup.root);
    assert.equal(await get.run(['config', 'get', 'run.maxTasks']), 0);
    assert.equal(get.stdout.text, '3\t(project)\n');

    for (const [args, pattern] of [
      [['config', 'set', 'run.maxTasks', '999'], /between 1 and 50 \(hard limit\)/],
      [['config', 'set', 'run.autoCommit', 'maybe'], /true or false/],
      [['config', 'set', 'run.unknown', '1'], /Unknown configuration key/],
      [['config', 'set', 'anthropic.apiKey', 'sk-ant-xyz'], /looks like a credential/],
      [['config', 'set', 'providers.implementer', 'ghp_abcdefghijklmnop'], /credential/],
    ] as const) {
      const attempt = cli(setup.root);
      assert.equal(await attempt.run([...args]), 1, args.join(' '));
      assert.match(attempt.stderr.text, pattern);
      assert.doesNotMatch(attempt.stderr.text, /sk-ant-xyz/, 'a refused secret value is never echoed back');
    }
    assert.equal(await cli(setup.root).run(['config', 'reset', 'run.maxTasks']), 0);
    assert.equal(await cli(setup.root).run(['config', 'validate']), 0);
    const kinds = (await setup.store.load()).controlEvents.map((event) => event.kind);
    assert.deepEqual(kinds, ['config-set', 'config-reset']);
  });

  it('project defaults apply to `forge run`, the command line overrides them, and hard limits always win', async () => {
    const setup = await orchestrationProject(temp);
    assert.equal(await cli(setup.root).run(['config', 'set', 'run.autoCommit', 'true']), 0);
    assert.equal(await cli(setup.root).run(['config', 'set', 'run.allowEdits', 'true']), 0);
    const fromProject = cli(setup.root);
    assert.equal(await fromProject.run(['run', '--dry-run']), 0);
    assert.match(fromProject.stdout.text, /Auto-commit:\s+enabled/);
    assert.match(fromProject.stdout.text, /project config \[access, autoCommit\]/);
    const overridden = cli(setup.root);
    assert.equal(await overridden.run(['run', '--dry-run', '--no-auto-commit']), 0);
    assert.match(overridden.stdout.text, /Auto-commit:\s+disabled/);
    assert.match(overridden.stdout.text, /command line \[autoCommit\]/);
    // A hand-edited file cannot bypass the hard limits.
    await writeFile(join(setup.project.layout.forgeDir, 'config.json'), JSON.stringify({ schemaVersion: 1, settings: { 'run.maxSteps': 100000 }, updatedAt: null }));
    const bypass = cli(setup.root);
    assert.equal(await bypass.run(['run', '--dry-run']), 1);
    assert.match(bypass.stderr.text, /run\.maxSteps must be a whole number between 1 and 200/);
  });
});

describe('preflight, status, explain, audit, provider (CLI)', () => {
  it('produce structured output and never mutate anything', async () => {
    const { setup, approvalId } = await stoppedOnConcerns();
    const before = await fingerprint(setup);
    const outputs: Record<string, string> = {};
    for (const args of [
      ['preflight'],
      ['status'],
      ['explain'],
      ['audit'],
      ['config', 'show'],
      ['config', 'get', 'run.maxTasks'],
      ['config', 'validate'],
      ['provider', 'list'],
      ['provider', 'check'],
      ['approval', 'list', '--all'],
      ['approval', 'show', approvalId.slice(0, 8)],
      ['run', 'status'],
      ['run', '--dry-run', '--allow-edits', '--review'],
    ]) {
      const command = cli(setup.root);
      await command.run(args);
      outputs[args.join(' ')] = command.stdout.text;
    }
    assert.equal(await fingerprint(setup), before, 'state, config, metadata, source, and Git are byte-identical');

    assert.match(outputs['preflight']!, /\[WARN\] Approvals\s+1 pending/);
    assert.match(outputs['preflight']!, /READY WITH WARNINGS/);
    assert.match(outputs['status']!, /Approvals:\s+[0-9a-f]{8} review-acceptance/);
    assert.match(outputs['status']!, /Human action:\s+1 approval\(s\) await a decision — forge approval show [0-9a-f]{8} \(HUMAN REVIEW REQUIRED\)/);
    assert.match(outputs['explain']!, /Forge stopped because Task 1\.1 received AI review concerns that need a human decision/);
    assert.match(outputs['explain']!, /AI review: CONCERNS/);
    assert.match(outputs['explain']!, new RegExp(`forge approval approve ${approvalId.slice(0, 8)}`));
    assert.match(outputs['audit']!, /approval requested/);
    assert.match(outputs['provider list']!, /implementer\s+claude\s+default/);
    assert.match(outputs['provider check']!, /\[PASS\] planner/);
  });
});

describe('forge init', () => {
  it('registers safely: config created, validation only suggested, no Git init, no installs, no worker', async () => {
    const root = await createRepo(temp, { 'README.md': '# App\n', 'package.json': JSON.stringify({ scripts: { test: 'node --test', build: 'tsc', start: 'node .' } }) });
    const worker = new FakeWorker(async () => ({}), { id: 'claude' });
    const init = cli(root, { workers: fakeRegistry(worker) });
    assert.equal(await init.run(['init']), 0);
    assert.match(init.stdout.text, /Registered project "repo"/);
    assert.match(init.stdout.text, /Created .*config\.json/);
    assert.match(init.stdout.text, /forge validation add --name test --executable npm -- run test/);
    assert.match(init.stdout.text, /NOT added/);
    assert.doesNotMatch(init.stdout.text, /--name start/);
    assert.equal(worker.requests.length, 0);
    await assert.rejects(readFile(join(root, '.forge', 'validation.json')), 'no check was added');
    await assert.rejects(readFile(join(root, 'node_modules', '.package-lock.json')), 'nothing was installed');

    const again = cli(root);
    assert.equal(await again.run(['init']), 0);
    assert.match(again.stdout.text, /already registered here; its registration and state were preserved/);
    assert.match(again.stdout.text, /Kept the existing configuration/);

    const notGit = (await temp.make('forge-not-git-')).replace(/\\/g, '/');
    const refused = cli(notGit);
    assert.equal(await refused.run(['init']), 1);
    assert.match(refused.stderr.text, /never runs `git init` for you/);
    await assert.rejects(readFile(join(notGit, '.git', 'HEAD')));
  });
});

describe('safe failure output', () => {
  it('redacts credential values from error messages and hides stack traces for unexpected errors', async () => {
    const setup = await orchestrationProject(temp);
    const secret = 'sk-test-SUPERSECRET-123456';
    const exploding = {
      list: () => [{ id: 'claude', aliases: [], displayName: 'Boom' }],
      create: () => {
        throw new Error(`provider exploded while using ${secret}`);
      },
    };
    const command = cli(setup.root, { env: { ANTHROPIC_API_KEY: secret }, workers: exploding });
    assert.equal(await command.run(['provider', 'check', '--role', 'implementer']), 1);
    assert.match(command.stderr.text, /internal error: provider exploded while using \[REDACTED\]/);
    assert.doesNotMatch(command.stderr.text, /SUPERSECRET/);
    assert.doesNotMatch(command.stderr.text, /\n\s+at /, 'no stack trace by default');
    assert.match(command.stderr.text, /FORGE_LOG_LEVEL=debug/);
    assert.doesNotMatch(JSON.stringify(await setup.store.load()), /SUPERSECRET/);
  });

  it('never prints environment values in diagnostics', async () => {
    const setup = await orchestrationProject(temp);
    const secret = 'ghp_SECRETTOKEN1234567890';
    for (const args of [['status'], ['preflight'], ['config', 'show'], ['provider', 'check']]) {
      const command = cli(setup.root, { env: { GITHUB_TOKEN: secret, FORGE_LOG_LEVEL: 'debug' } });
      await command.run(args);
      assert.doesNotMatch(command.stdout.text + command.stderr.text, /SECRETTOKEN/, args.join(' '));
    }
  });
});

describe('manual commands keep working', () => {
  it('task review / review-accept and plan list are unaffected by the approval layer', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    await makeOrchestrator(setup, worker, { maxSteps: 1 }).run();
    const reviewer = FakeAiProvider.answering(reviewJson([{ severity: 'warning', title: 'x' }]), 'claude');
    const review = cli(setup.root, { aiProviders: aiRegistry(reviewer) });
    assert.equal(await review.run(['task', 'review', '1.1']), 0);
    assert.equal(await cli(setup.root).run(['task', 'review-accept', '1.1', '--reason', 'fine']), 0);
    assert.equal(await cli(setup.root).run(['plan', 'list']), 0);
    await write(setup.root, 'notes.txt', 'x');
    assert.equal(await cli(setup.root).run(['validation', 'list']), 0);
  });
});
