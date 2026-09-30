import { loadConfig } from '../config/index.ts';
import { readForgeVersion } from '../core/version.ts';
import { createConsoleSink, createLogger } from '../logging/index.ts';
import type { LogLevel } from '../logging/index.ts';
import { runCli } from './run-cli.ts';
import type { ExitCodeValue } from './types.ts';

/** Wires the real process environment into the CLI. */
export async function main(argv: readonly string[]): Promise<ExitCodeValue> {
  // The first Ctrl+C cancels running work (workers are stopped and the
  // outcome recorded); a second one falls through to Node's default exit.
  const interrupt = new AbortController();
  const onInterrupt = (): void => {
    process.stderr.write('\nInterrupted: cancelling…\n');
    interrupt.abort();
  };
  process.once('SIGINT', onInterrupt);

  try {
    return await runCli(argv, {
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
      cwd: process.cwd(),
      version: readForgeVersion(),
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
      logger: createLogger({ level: resolveLogLevel(), sink: createConsoleSink(process.stderr) }),
      signal: interrupt.signal,
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

/**
 * Invalid configuration must not prevent `--help` or `doctor` from running
 * (doctor reports it), so logging falls back to the default level here.
 */
function resolveLogLevel(): LogLevel {
  try {
    return loadConfig(process.env).logLevel;
  } catch {
    return 'info';
  }
}
