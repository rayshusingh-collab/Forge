import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG, MAX_PROCESS_TIMEOUT_MS, loadConfig } from '../src/config/index.ts';
import { ConfigurationError } from '../src/core/errors.ts';

describe('loadConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    assert.deepEqual(loadConfig({}), {
      logLevel: 'info',
      processTimeoutMs: 120_000,
      mode: 'production',
      workerTimeoutMs: 600_000,
      claudeExecutable: null,
    });
  });

  it('treats blank values as unset', () => {
    assert.deepEqual(loadConfig({ FORGE_LOG_LEVEL: '  ', FORGE_PROCESS_TIMEOUT_MS: '', FORGE_ENV: '' }), DEFAULT_CONFIG);
  });

  it('applies valid overrides', () => {
    const claudePath = process.platform === 'win32' ? 'C:\\Tools\\Claude Code\\claude.exe' : '/opt/claude code/claude';
    const config = loadConfig({
      FORGE_LOG_LEVEL: 'debug',
      FORGE_PROCESS_TIMEOUT_MS: '5000',
      FORGE_ENV: 'development',
      FORGE_WORKER_TIMEOUT_MS: '900000',
      FORGE_CLAUDE_EXECUTABLE: claudePath,
    });
    assert.deepEqual(config, {
      logLevel: 'debug',
      processTimeoutMs: 5000,
      mode: 'development',
      workerTimeoutMs: 900_000,
      claudeExecutable: claudePath,
    });
  });

  it('normalizes case and surrounding whitespace of enum values', () => {
    const config = loadConfig({ FORGE_LOG_LEVEL: ' WARN ', FORGE_ENV: 'Test' });
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.mode, 'test');
  });

  it('accepts the timeout bounds', () => {
    assert.equal(loadConfig({ FORGE_PROCESS_TIMEOUT_MS: '1' }).processTimeoutMs, 1);
    assert.equal(
      loadConfig({ FORGE_PROCESS_TIMEOUT_MS: String(MAX_PROCESS_TIMEOUT_MS) }).processTimeoutMs,
      MAX_PROCESS_TIMEOUT_MS,
    );
  });

  it('returns an immutable object', () => {
    assert.ok(Object.isFrozen(loadConfig({})));
  });

  it('rejects an invalid log level', () => {
    assert.throws(() => loadConfig({ FORGE_LOG_LEVEL: 'verbose' }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.code, 'CONFIGURATION_ERROR');
      assert.match(error.issues[0] ?? '', /FORGE_LOG_LEVEL must be one of: debug, info, warn, error/);
      return true;
    });
  });

  it('rejects an invalid runtime mode', () => {
    assert.throws(() => loadConfig({ FORGE_ENV: 'staging' }), ConfigurationError);
  });

  for (const value of ['0', '-5', 'abc', '1e3', '10.5', '12ms', String(MAX_PROCESS_TIMEOUT_MS + 1)]) {
    it(`rejects process timeout "${value}"`, () => {
      assert.throws(() => loadConfig({ FORGE_PROCESS_TIMEOUT_MS: value }), (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /FORGE_PROCESS_TIMEOUT_MS must be an integer/);
        return true;
      });
    });
  }

  for (const value of ['0', 'forever', '-1']) {
    it(`rejects worker timeout "${value}"`, () => {
      assert.throws(() => loadConfig({ FORGE_WORKER_TIMEOUT_MS: value }), /FORGE_WORKER_TIMEOUT_MS must be an integer/);
    });
  }

  for (const value of ['claude', './bin/claude', 'bin\\claude.exe']) {
    it(`rejects a non-absolute Claude executable "${value}"`, () => {
      assert.throws(() => loadConfig({ FORGE_CLAUDE_EXECUTABLE: value }), /FORGE_CLAUDE_EXECUTABLE must be an absolute path/);
    });
  }

  it('reports every invalid value at once', () => {
    assert.throws(
      () => loadConfig({ FORGE_LOG_LEVEL: 'loud', FORGE_PROCESS_TIMEOUT_MS: 'never', FORGE_ENV: 'prod' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.issues.length, 3);
        return true;
      },
    );
  });
});
