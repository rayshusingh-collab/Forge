import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { isSupportedNodeVersion } from '../src/core/node-version.ts';
import { readForgeVersion } from '../src/core/version.ts';
import { silentLogger } from '../src/logging/index.ts';
import { CapturingWriter } from './helpers.ts';

interface TestCli {
  readonly context: CliContext;
  readonly stdout: CapturingWriter;
  readonly stderr: CapturingWriter;
}

function createTestCli(overrides: Partial<CliContext> = {}): TestCli {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const context: CliContext = {
    stdout,
    stderr,
    env: {},
    cwd: process.cwd(),
    version: '9.9.9',
    nodeVersion: 'v24.0.0',
    nodeExecutable: process.execPath,
    logger: silentLogger,
    ...overrides,
  };
  return { context, stdout, stderr };
}

describe('CLI', () => {
  for (const argv of [['--help'], ['-h'], ['help'], []]) {
    it(`prints help for ${JSON.stringify(argv)}`, async () => {
      const cli = createTestCli();
      assert.equal(await runCli(argv, cli.context), 0);
      assert.match(cli.stdout.text, /Usage:/);
      assert.match(cli.stdout.text, /doctor/);
    });
  }

  it('prints the version', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['--version'], cli.context), 0);
    assert.equal(cli.stdout.text, '9.9.9\n');
  });

  it('rejects an unknown command with a usage exit code', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['deploy'], cli.context), 2);
    assert.match(cli.stderr.text, /unknown command "deploy"/);
    assert.equal(cli.stdout.text, '');
  });

  it('rejects an unknown option', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['--force'], cli.context), 2);
    assert.match(cli.stderr.text, /unknown option "--force"/);
  });

  it('shows command help', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['doctor', '--help'], cli.context), 0);
    assert.match(cli.stdout.text, /Usage: forge doctor/);
  });

  it('doctor passes on a healthy runtime', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['doctor'], cli.context), 0);
    assert.match(cli.stdout.text, /\[PASS\] Node.js runtime/);
    assert.match(cli.stdout.text, /\[PASS\] Configuration/);
    assert.match(cli.stdout.text, /\[PASS\] Process runner/);
    assert.match(cli.stdout.text, /\[PASS\] Git: git version/);
    assert.match(cli.stdout.text, /All checks passed/);
  });

  it('doctor fails and explains invalid configuration', async () => {
    const cli = createTestCli({ env: { FORGE_LOG_LEVEL: 'verbose' } });
    assert.equal(await runCli(['doctor'], cli.context), 1);
    assert.match(cli.stdout.text, /\[FAIL\] Configuration/);
    assert.match(cli.stdout.text, /FORGE_LOG_LEVEL/);
    assert.match(cli.stdout.text, /1 check\(s\) failed/);
  });

  it('doctor rejects unexpected arguments', async () => {
    const cli = createTestCli();
    assert.equal(await runCli(['doctor', 'extra'], cli.context), 2);
  });
});

describe('runDoctor', () => {
  const base = { env: {}, nodeExecutable: process.execPath, cwd: process.cwd() };

  it('fails on an unsupported Node version', async () => {
    const report = await runDoctor({ ...base, nodeVersion: 'v20.11.0' });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === 'Node.js runtime')?.status, 'fail');
  });

  it('fails the Git check when Git is missing', async () => {
    const report = await runDoctor({ ...base, nodeVersion: 'v24.0.0', gitExecutable: 'forge-missing-git-7f3a' });
    assert.equal(report.ok, false);
    const git = report.checks.find((check) => check.name === 'Git');
    assert.equal(git?.status, 'fail');
    assert.match(git?.detail ?? '', /not found on PATH/);
  });

  it('fails the runner check when the executable is missing', async () => {
    const report = await runDoctor({ ...base, nodeVersion: 'v24.0.0', nodeExecutable: 'forge-missing-node-7f3a' });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === 'Process runner')?.status, 'fail');
  });
});

describe('runtime helpers', () => {
  it('compares Node versions against the minimum', () => {
    assert.equal(isSupportedNodeVersion('v22.18.0'), true);
    assert.equal(isSupportedNodeVersion('v24.21.0'), true);
    assert.equal(isSupportedNodeVersion('v22.17.9'), false);
    assert.equal(isSupportedNodeVersion('v18.20.0'), false);
    assert.equal(isSupportedNodeVersion('garbage'), false);
  });

  it('reads the version from package.json', () => {
    assert.match(readForgeVersion(), /^\d+\.\d+\.\d+/);
  });
});
