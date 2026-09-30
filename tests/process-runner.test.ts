import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ProcessExecutionError, ProcessTimeoutError, ValidationError } from '../src/core/errors.ts';
import { ProcessRunner, assertProcessSucceeded } from '../src/execution/index.ts';
import type { ProcessRequest } from '../src/execution/index.ts';
import { createLogger } from '../src/logging/index.ts';
import { MemorySink } from './helpers.ts';

// All child processes are Node itself, so these tests behave the same on
// Windows, macOS, and Linux without relying on shell utilities.
const NODE = process.execPath;

function nodeScript(script: string, overrides: Partial<ProcessRequest> = {}): ProcessRequest {
  return { command: NODE, args: ['-e', script], cwd: workDir, ...overrides };
}

let workDir: string;

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'forge-runner-test-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('ProcessRunner', () => {
  const runner = new ProcessRunner({ defaultTimeoutMs: 30_000, killGraceMs: 500 });

  it('runs a successful process and captures stdout', async () => {
    const result = await runner.run(nodeScript(`process.stdout.write('hello from child')`));

    assert.equal(result.outcome, 'success');
    assert.equal(result.exitCode, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, 'hello from child');
    assert.equal(result.stderr, '');
    assert.equal(result.spawnError, undefined);
    assert.equal(result.command, NODE);
    assert.equal(result.cwd, workDir);
    assert.equal(result.timeoutMs, 30_000);
    assert.ok(result.durationMs >= 0);
    assert.ok(result.startedAt instanceof Date);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runner.run(nodeScript(`process.stdout.write('out'); process.stderr.write('err')`));

    assert.equal(result.outcome, 'success');
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  });

  it('passes arguments verbatim without shell interpretation', async () => {
    const tricky = ['a b', '"quoted"', '$HOME', '%PATH%', '&& echo injected', '|', '*'];
    const result = await runner.run({
      command: NODE,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
      cwd: workDir,
    });

    assert.equal(result.outcome, 'success');
    assert.deepEqual(JSON.parse(result.stdout), tricky);
  });

  it('runs in the requested working directory', async () => {
    await writeFile(join(workDir, 'marker.txt'), 'present');
    const result = await runner.run(
      nodeScript(`process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))`),
    );
    assert.equal(result.stdout, 'present');
  });

  it('merges extra environment variables', async () => {
    const result = await runner.run(
      nodeScript(`process.stdout.write(process.env.FORGE_TEST_VALUE ?? 'missing')`, {
        env: { FORGE_TEST_VALUE: 'from-request' },
      }),
    );
    assert.equal(result.stdout, 'from-request');
  });

  it('decodes multi-byte UTF-8 output', async () => {
    const result = await runner.run(nodeScript(`process.stdout.write('héllo ✓ 世界')`));
    assert.equal(result.stdout, 'héllo ✓ 世界');
  });

  it('reports a non-zero exit code', async () => {
    const result = await runner.run(nodeScript(`process.stderr.write('boom'); process.exit(3)`));

    assert.equal(result.outcome, 'non-zero-exit');
    assert.equal(result.exitCode, 3);
    assert.equal(result.stderr, 'boom');
  });

  it('times out and terminates a long-running process', async () => {
    const result = await runner.run(nodeScript(`setTimeout(() => {}, 60_000)`, { timeoutMs: 300 }));

    assert.equal(result.outcome, 'timeout');
    assert.equal(result.timeoutMs, 300);
    assert.ok(result.durationMs >= 250, `duration ${result.durationMs} should reflect the timeout`);
    assert.ok(result.durationMs < 10_000, `duration ${result.durationMs} should not wait for the child`);
  });

  it('keeps output produced before a timeout', async () => {
    const result = await runner.run(
      nodeScript(`process.stdout.write('partial'); setTimeout(() => {}, 60_000)`, { timeoutMs: 1_000 }),
    );
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.stdout, 'partial');
  });

  it('forces termination when the process ignores the graceful signal', async () => {
    // On POSIX the child ignores SIGTERM, so the runner must escalate to SIGKILL.
    // On Windows SIGTERM is already forceful; the test still verifies timeout handling.
    const result = await runner.run(
      nodeScript(`process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)`, { timeoutMs: 300 }),
    );
    assert.equal(result.outcome, 'timeout');
    assert.ok(result.durationMs < 10_000);
  });

  it('does not hang when a descendant process keeps the output pipes open', async () => {
    // The child starts a grandchild that inherits stdout/stderr and outlives the
    // child. On POSIX, killing the child leaves the pipes open, so the runner's
    // fallback must stop waiting; on Windows 'close' already follows the child's
    // exit. Either way the run must end promptly. The grandchild exits after 5 s.
    const script = [
      `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });`,
      `setInterval(() => {}, 1000);`,
    ].join(' ');
    const fastRunner = new ProcessRunner({ defaultTimeoutMs: 300, killGraceMs: 300 });

    const result = await fastRunner.run(nodeScript(script));

    assert.equal(result.outcome, 'timeout');
    assert.ok(result.durationMs < 4_000, `duration ${result.durationMs} should not wait for the grandchild`);
  });

  it('uses the runner default timeout when the request has none', async () => {
    const shortRunner = new ProcessRunner({ defaultTimeoutMs: 300, killGraceMs: 500 });
    const result = await shortRunner.run(nodeScript(`setTimeout(() => {}, 60_000)`));
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.timeoutMs, 300);
  });

  it('cancels a running process via AbortSignal', async () => {
    const controller = new AbortController();
    const pending = runner.run(nodeScript(`setTimeout(() => {}, 60_000)`, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 200);

    const result = await pending;
    assert.equal(result.outcome, 'cancelled');
  });

  it('does not start a process when already cancelled', async () => {
    const result = await runner.run(nodeScript(`process.stdout.write('ran')`, { signal: AbortSignal.abort() }));
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.exitCode, null);
    assert.equal(result.stdout, '');
  });

  it('truncates output beyond the capture limit', async () => {
    const limited = new ProcessRunner({ defaultTimeoutMs: 30_000, maxOutputBytes: 100 });
    const result = await limited.run(nodeScript(`process.stdout.write('x'.repeat(5000))`));

    assert.equal(result.outcome, 'success');
    assert.equal(result.stdout.length, 100);
    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, false);
  });

  it('reports a spawn failure for a missing executable', async () => {
    const result = await runner.run({ command: 'forge-definitely-missing-executable-7f3a', cwd: workDir });

    assert.equal(result.outcome, 'spawn-error');
    assert.equal(result.exitCode, null);
    assert.equal(result.spawnError?.code, 'ENOENT');
  });

  describe('request validation', () => {
    it('rejects a working directory that does not exist', async () => {
      await assert.rejects(
        runner.run(nodeScript('', { cwd: join(workDir, 'does-not-exist') })),
        (error: unknown) => {
          assert.ok(error instanceof ValidationError);
          assert.match(error.message, /does not exist/);
          return true;
        },
      );
    });

    it('rejects a working directory that is a file', async () => {
      const file = join(workDir, 'not-a-dir.txt');
      await writeFile(file, '');
      await assert.rejects(runner.run(nodeScript('', { cwd: file })), /is not a directory/);
    });

    it('rejects a relative working directory', async () => {
      await assert.rejects(runner.run(nodeScript('', { cwd: '.' })), /must be an absolute path/);
    });

    it('rejects an empty working directory', async () => {
      await assert.rejects(runner.run(nodeScript('', { cwd: '' })), ValidationError);
    });

    it('rejects an empty command', async () => {
      await assert.rejects(runner.run({ command: '  ', cwd: workDir }), ValidationError);
    });

    it('rejects arguments containing NUL characters', async () => {
      await assert.rejects(runner.run({ command: NODE, args: ['a\0b'], cwd: workDir }), ValidationError);
    });

    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`rejects timeout ${timeoutMs}`, async () => {
        await assert.rejects(runner.run(nodeScript('', { timeoutMs })), ValidationError);
      });
    }

    it('rejects invalid runner options', () => {
      assert.throws(() => new ProcessRunner({ defaultTimeoutMs: 0 }), ValidationError);
      assert.throws(() => new ProcessRunner({ defaultTimeoutMs: 1000, maxOutputBytes: -1 }), ValidationError);
    });
  });

  it('logs execution without leaking environment values', async () => {
    const sink = new MemorySink();
    const logged = new ProcessRunner({
      defaultTimeoutMs: 30_000,
      logger: createLogger({ level: 'debug', sink }),
    });

    await logged.run(nodeScript(`process.exit(0)`, { env: { FORGE_SECRET_VALUE: 'super-secret-value' } }));

    const messages = sink.records.map((record) => record.message);
    assert.deepEqual(messages, ['Starting process', 'Process finished']);
    assert.ok(!JSON.stringify(sink.records).includes('super-secret-value'));
  });
});

describe('assertProcessSucceeded', () => {
  const runner = new ProcessRunner({ defaultTimeoutMs: 30_000, killGraceMs: 500 });

  it('does nothing for a successful result', async () => {
    assertProcessSucceeded(await runner.run(nodeScript('')));
  });

  it('throws ProcessExecutionError for a non-zero exit', async () => {
    const result = await runner.run(nodeScript(`process.stderr.write('bad'); process.exit(2)`));
    assert.throws(() => assertProcessSucceeded(result), (error: unknown) => {
      assert.ok(error instanceof ProcessExecutionError);
      assert.equal(error.code, 'PROCESS_EXECUTION_ERROR');
      assert.match(error.message, /exited with code 2/);
      assert.equal(error.details['stderr'], 'bad');
      return true;
    });
  });

  it('throws ProcessTimeoutError for a timeout', async () => {
    const result = await runner.run(nodeScript(`setTimeout(() => {}, 60_000)`, { timeoutMs: 200 }));
    assert.throws(() => assertProcessSucceeded(result), ProcessTimeoutError);
  });

  it('throws ProcessExecutionError for a spawn failure', async () => {
    const result = await runner.run({ command: 'forge-definitely-missing-executable-7f3a', cwd: workDir });
    assert.throws(() => assertProcessSucceeded(result), /could not be started/);
  });
});
