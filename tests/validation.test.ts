import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import { ValidationConfigError } from '../src/core/errors.ts';
import { ProcessRunner, resolveExecutable } from '../src/execution/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { silentLogger } from '../src/logging/index.ts';
import {
  ValidationProfileStore,
  normalizeCheck,
  profileHash,
  resolveCheckExecutable,
  runValidation,
} from '../src/validation/index.ts';
import type { ValidationProfile } from '../src/validation/index.ts';
import { CapturingWriter } from './helpers.ts';
import { TempDirs } from './fixtures.ts';
import { createRegisteredRepo, nodeCheck } from './git-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const runner = new ProcessRunner({ defaultTimeoutMs: 60_000, killGraceMs: 300 });

function profile(...checks: ReturnType<typeof normalizeCheck>[]): ValidationProfile {
  return { schemaVersion: 1, checks, updatedAt: null };
}

async function cli(project: LoadedProject, ...argv: string[]) {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const exitCode = await runCli(argv, {
    stdout,
    stderr,
    env: {},
    cwd: project.layout.root,
    version: 'test',
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: silentLogger,
  });
  return { exitCode, stdout: stdout.text, stderr: stderr.text };
}

describe('validation configuration', () => {
  it('normalizes checks and applies defaults', () => {
    const check = normalizeCheck({ id: 'test', executable: 'npm', args: ['test'] });
    assert.deepEqual(check, { id: 'test', executable: 'npm', args: ['test'], cwd: '.', timeoutMs: 600_000, required: true });
    assert.equal(normalizeCheck({ id: 'x', executable: './node_modules/.bin/tsc', cwd: 'pkg\\web\\' }).executable, 'node_modules/.bin/tsc');
    assert.equal(normalizeCheck({ id: 'x', executable: 'npm', cwd: 'pkg\\web\\' }).cwd, 'pkg/web');
  });

  const invalid: readonly (readonly [string, Parameters<typeof normalizeCheck>[0], RegExp])[] = [
    ['an invalid name', { id: 'Test Check', executable: 'npm' }, /Check name/],
    ['shell syntax as a program', { id: 't', executable: 'npm test && rm -rf /' }, /looks like shell syntax/],
    ['a quoted program', { id: 't', executable: '"C:/x/npm" test' }, /looks like shell syntax/],
    ['a program name with spaces', { id: 't', executable: 'npm test' }, /not a plain program name/],
    ['a pipe as a program', { id: 't', executable: 'a|b' }, /looks like shell syntax/],
    ['an escaping program path', { id: 't', executable: '../outside/tool' }, /must stay inside the project/],
    ['a program in .forge', { id: 't', executable: '.forge/evil' }, /must not be inside \.forge/],
    ['an escaping working directory', { id: 't', executable: 'npm', cwd: '../..' }, /must stay inside the project/],
    ['an absolute working directory', { id: 't', executable: 'npm', cwd: process.platform === 'win32' ? 'C:\\' : '/' }, /relative to the project root/],
    ['a working directory in .git', { id: 't', executable: 'npm', cwd: '.git/hooks' }, /must not be inside/],
    ['a zero timeout', { id: 't', executable: 'npm', timeoutMs: 0 }, /Timeout must be between/],
    ['a huge timeout', { id: 't', executable: 'npm', timeoutMs: 90_000_000 }, /Timeout must be between/],
    ['a NUL argument', { id: 't', executable: 'npm', args: ['a\0b'] }, /Invalid argument/],
  ];
  for (const [label, input, pattern] of invalid) {
    it(`rejects ${label}`, () => {
      assert.throws(() => normalizeCheck(input), (error: unknown) => error instanceof ValidationConfigError && pattern.test(error.message));
    });
  }

  it('adds, lists, and removes checks through the store, refusing duplicates', async () => {
    const project = await createRegisteredRepo(temp);
    const store = new ValidationProfileStore(project.layout);
    assert.deepEqual((await store.load()).checks, []);
    await store.addCheck(normalizeCheck({ id: 'test', executable: 'npm', args: ['test'] }));
    await store.addCheck(normalizeCheck({ id: 'lint', executable: 'npm', args: ['run', 'lint'], required: false }));
    await assert.rejects(store.addCheck(normalizeCheck({ id: 'test', executable: 'node' })), /already exists/);
    assert.deepEqual((await store.load()).checks.map((check) => check.id), ['test', 'lint']);
    await store.removeCheck('test');
    assert.deepEqual((await store.load()).checks.map((check) => check.id), ['lint']);
    await assert.rejects(store.removeCheck('test'), /No check named "test"/);
  });

  it('rejects a malformed or tampered profile file instead of running it', async () => {
    const project = await createRegisteredRepo(temp);
    const file = join(project.layout.forgeDir, 'validation.json');
    const store = new ValidationProfileStore(project.layout);
    for (const content of [
      '{ nope',
      JSON.stringify({ schemaVersion: 1, checks: [{ id: 't', executable: 'npm test; calc', args: [], cwd: '.', timeoutMs: 1000, required: true }], updatedAt: null }),
      JSON.stringify({ schemaVersion: 1, checks: [{ id: 't', executable: 'npm', args: [], cwd: '.', timeoutMs: 1000, required: true, shell: true }], updatedAt: null }),
      JSON.stringify({ schemaVersion: 2, checks: [], updatedAt: null }),
      JSON.stringify({ schemaVersion: 1, checks: [nodeCheck('a', 'true'), nodeCheck('a', 'true')], updatedAt: null }),
    ]) {
      await writeFile(file, content);
      await assert.rejects(store.load(), ValidationConfigError, content.slice(0, 60));
    }
  });

  it('hashes the profile deterministically', () => {
    const one = profile(normalizeCheck({ id: 'a', executable: 'npm' }));
    assert.equal(profileHash(one), profileHash(profile(normalizeCheck({ id: 'a', executable: 'npm' }))));
    assert.notEqual(profileHash(one), profileHash(profile(normalizeCheck({ id: 'a', executable: 'npx' }))));
  });
});

describe('check executable resolution', () => {
  it('resolves a project-local npm-style .bin launcher without a shell', async () => {
    const project = await createRegisteredRepo(temp);
    const bin = join(project.layout.root, 'node_modules', '.bin');
    await mkdir(join(project.layout.root, 'node_modules', 'tool'), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(project.layout.root, 'node_modules', 'tool', 'cli.js'), 'process.exit(0)');
    await writeFile(join(bin, 'tool'), '#!/bin/sh\n'); // the POSIX launcher npm also writes
    await writeFile(join(bin, 'tool.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\..\\tool\\cli.js" %*\r\n');

    const resolution = await resolveCheckExecutable({ executable: 'node_modules/.bin/tool' }, project);
    if (process.platform === 'win32') {
      assert.ok(resolution.ok, resolution.ok ? '' : resolution.message);
      assert.equal(resolution.executable.kind, 'node-script');
      assert.ok(resolution.executable.prefixArgs[0]!.endsWith(join('node_modules', 'tool', 'cli.js')));
    } else {
      assert.equal(resolution.ok, false, 'the extensionless shell launcher is not executable here');
    }
  });

  it('refuses a project-relative program that escapes through a link or is missing', async () => {
    const project = await createRegisteredRepo(temp);
    const missing = await resolveCheckExecutable({ executable: 'node_modules/.bin/nothing' }, project);
    assert.equal(missing.ok, false);
  });

  it('unwraps npm\'s own launcher format (npm.cmd / npx.cmd)', async () => {
    const dir = await temp.make('forge-npm-launcher-');
    await mkdir(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '');
    await writeFile(
      join(dir, 'npm.cmd'),
      [
        ':: Created by npm, please don\'t edit manually.',
        '@ECHO OFF',
        'SETLOCAL',
        'SET "NODE_EXE=%~dp0\\node.exe"',
        'IF NOT EXIST "%NODE_EXE%" (',
        '  SET "NODE_EXE=node"',
        ')',
        'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
        'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
        'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
        '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
        ')',
        '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
        '',
      ].join('\r\n'),
    );
    const resolution = await resolveExecutable('npm', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' });
    assert.ok(resolution.ok, resolution.ok ? '' : resolution.message);
    assert.equal(resolution.executable.kind, 'node-script');
    assert.deepEqual(resolution.executable.prefixArgs, [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]);
  });

  it('runs the real npm on this machine without a shell', { skip: process.platform !== 'win32' ? 'Windows launcher check' : false }, async () => {
    const resolution = await resolveExecutable('npm');
    assert.ok(resolution.ok, resolution.ok ? '' : resolution.message);
    const result = await runner.run({
      command: resolution.executable.command,
      args: [...resolution.executable.prefixArgs, '--version'],
      cwd: await temp.make(),
    });
    assert.equal(result.outcome, 'success', result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it('still refuses unrecognized batch files', async () => {
    const dir = await temp.make('forge-bat-');
    await writeFile(join(dir, 'evil.cmd'), '@echo off\r\ncalc.exe & "%NODE_EXE%" "%X%" %*\r\n');
    const resolution = await resolveExecutable('evil', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' });
    assert.equal(resolution.ok, false);
  });
});

describe('validator', () => {
  async function setup(): Promise<LoadedProject> {
    return createRegisteredRepo(temp, { 'README.md': 'x', 'ok.txt': 'ok' });
  }

  it('passes when all required checks pass, in configured order', async () => {
    const project = await setup();
    const record = await runValidation(
      profile(
        normalizeCheck(nodeCheck('first', "require('fs').existsSync('ok.txt')")),
        normalizeCheck(nodeCheck('second', 'true')),
      ),
      { project, runner },
    );
    assert.equal(record.status, 'passed');
    assert.deepEqual(record.checks.map((check) => [check.id, check.status, check.exitCode]), [
      ['first', 'passed', 0],
      ['second', 'passed', 0],
    ]);
    assert.match(record.profileHash, /^[0-9a-f]{64}$/);
    assert.equal(record.checks[0]!.stdout, null, 'output of passing checks is not stored');
  });

  it('fails on a required failure but still runs every check', async () => {
    const project = await setup();
    const record = await runValidation(
      profile(
        normalizeCheck({ id: 'fails', executable: process.execPath, args: ['-e', "console.error('3 tests failed'); process.exit(2)"], cwd: '.' }),
        normalizeCheck(nodeCheck('after', 'true')),
      ),
      { project, runner },
    );
    assert.equal(record.status, 'failed');
    assert.deepEqual(record.checks.map((check) => check.status), ['failed', 'passed']);
    assert.equal(record.checks[0]!.exitCode, 2);
    assert.equal(record.checks[0]!.stderr, '3 tests failed');
    assert.equal(record.checks[0]!.diagnostic, 'exited with code 2');
  });

  it('records an optional failure without failing the result', async () => {
    const project = await setup();
    const record = await runValidation(
      profile(normalizeCheck(nodeCheck('required', 'true')), normalizeCheck(nodeCheck('lint', 'false', { required: false }))),
      { project, runner },
    );
    assert.equal(record.status, 'passed');
    assert.equal(record.checks[1]!.status, 'failed');
  });

  it('times out a hung check', async () => {
    const project = await setup();
    const record = await runValidation(
      profile(normalizeCheck({ id: 'hang', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 1_000 })),
      { project, runner },
    );
    assert.equal(record.status, 'timed-out');
    assert.match(record.checks[0]!.diagnostic ?? '', /did not finish within 1 s/);
  });

  it('stops on cancellation and skips the remaining checks', async () => {
    const project = await setup();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const record = await runValidation(
      profile(
        normalizeCheck({ id: 'slow', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60_000 }),
        normalizeCheck(nodeCheck('never', 'true')),
      ),
      { project, runner, signal: controller.signal },
    );
    assert.equal(record.status, 'cancelled');
    assert.deepEqual(record.checks.map((check) => check.status), ['cancelled', 'skipped']);
  });

  it('reports a missing program as a configuration error and a failed start as an execution error', async () => {
    const project = await setup();
    const missing = await runValidation(profile(normalizeCheck({ id: 'x', executable: 'forge-no-such-tool-7f3a' })), { project, runner });
    assert.equal(missing.status, 'configuration-error');

    const spawnFailure = await runValidation(profile(normalizeCheck({ id: 'x', executable: 'tool' })), {
      project,
      runner: { run: async (request) => ({ ...(await runner.run({ ...request, command: 'forge-missing-binary-7f3a' })) }) },
      resolve: async () => ({ ok: true, executable: { command: 'forge-missing-binary-7f3a', prefixArgs: [], source: 'x', kind: 'native' } }),
    });
    assert.equal(spawnFailure.status, 'execution-error');
  });

  it('reports a missing working directory as a configuration error', async () => {
    const project = await setup();
    const record = await runValidation(profile(normalizeCheck({ id: 'x', executable: process.execPath, cwd: 'no/such/dir' })), {
      project,
      runner,
    });
    assert.equal(record.status, 'configuration-error');
  });

  it('bounds stored output to a tail excerpt', async () => {
    const project = await setup();
    const record = await runValidation(
      profile(normalizeCheck({ id: 'noisy', executable: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(100000) + 'END'); process.exit(1)"] })),
      { project, runner },
    );
    const stdout = record.checks[0]!.stdout!;
    assert.ok(stdout.length <= 500);
    assert.ok(stdout.endsWith('END'));
    assert.equal(record.checks[0]!.outputTruncated, true);
  });

  it('runs checks in a configured subdirectory', async () => {
    const project = await setup();
    await mkdir(join(project.layout.root, 'pkg'));
    await writeFile(join(project.layout.root, 'pkg', 'marker'), '');
    const record = await runValidation(
      profile(normalizeCheck({ ...nodeCheck('sub', "require('fs').existsSync('marker')"), cwd: 'pkg' })),
      { project, runner },
    );
    assert.equal(record.status, 'passed');
  });
});

describe('forge validation CLI', () => {
  it('adds, lists, shows, runs, and removes checks', async () => {
    const project = await createRegisteredRepo(temp);
    const added = await cli(project, 'validation', 'add', '--name', 'node-ok', '--executable', process.execPath, '--timeout', '30', '--', '-e', 'process.exit(0)');
    assert.equal(added.exitCode, 0, added.stderr);
    assert.match(added.stdout, /Added required check "node-ok"/);
    assert.equal((await cli(project, 'validation', 'add', '--name', 'opt', '--executable', process.execPath, '--optional', '--arg=-e', '--arg=0')).exitCode, 0);

    const list = await cli(project, 'validation', 'list');
    assert.match(list.stdout, /1\s+node-ok\s+required\s+30s\s+\.\s+.*-e "process\.exit\(0\)"/);
    assert.match(list.stdout, /2\s+opt\s+optional/);

    assert.match((await cli(project, 'validation', 'show', 'node-ok')).stdout, /Resolves to: .*node/i);
    const run = await cli(project, 'validation', 'run');
    assert.equal(run.exitCode, 0);
    assert.match(run.stdout, /node-ok\s+PASS/);
    assert.match(run.stdout, /Overall: PASSED \(nothing was recorded\)/);

    assert.equal((await cli(project, 'validation', 'remove', 'opt')).exitCode, 0);
    assert.doesNotMatch((await cli(project, 'validation', 'list')).stdout, /opt/);
    const stored = JSON.parse(await readFile(join(project.layout.forgeDir, 'validation.json'), 'utf8')) as { checks: unknown[] };
    assert.equal(stored.checks.length, 1);
  });

  it('refuses unresolvable programs, bad directories, and missing options at configuration time', async () => {
    const project = await createRegisteredRepo(temp);
    const missing = await cli(project, 'validation', 'add', '--name', 't', '--executable', 'forge-no-such-tool-7f3a');
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /Cannot use "forge-no-such-tool-7f3a"/);
    const badDir = await cli(project, 'validation', 'add', '--name', 't', '--executable', process.execPath, '--cwd', 'nope');
    assert.equal(badDir.exitCode, 1);
    assert.equal((await cli(project, 'validation', 'add', '--name', 't')).exitCode, 2);
    assert.equal((await cli(project, 'validation', 'add', '--name', 't', '--executable', 'npm', '--timeout', '1m')).exitCode, 2);
    assert.match((await cli(project, 'validation', 'list')).stdout, /No validation checks configured/);
  });
});
