import { loadConfig } from '../config/index.ts';
import { readForgeVersion } from '../core/version.ts';
import { createConsoleSink, createLogger } from '../logging/index.ts';
import type { LogLevel } from '../logging/index.ts';
import { runCli } from './run-cli.ts';
import type { ExitCodeValue } from './types.ts';

/** Wires the real process environment into the CLI. */
export async function main(argv: readonly string[]): Promise<ExitCodeValue> {
  return runCli(argv, {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    version: readForgeVersion(),
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: createLogger({ level: resolveLogLevel(), sink: createConsoleSink(process.stderr) }),
  });
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
