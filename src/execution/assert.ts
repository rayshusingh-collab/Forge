import { ProcessExecutionError, ProcessTimeoutError } from '../core/errors.ts';
import type { ProcessResult } from './types.ts';

/** Maximum characters of stderr copied into error details, to keep errors readable. */
const STDERR_EXCERPT_LENGTH = 2_000;

/**
 * Converts an unsuccessful `ProcessResult` into a typed Forge error.
 * Error details include diagnostics but never the process environment.
 */
export function assertProcessSucceeded(result: ProcessResult): void {
  if (result.outcome === 'success') {
    return;
  }

  const details = {
    command: result.command,
    args: result.args,
    cwd: result.cwd,
    outcome: result.outcome,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stderr: result.stderr.slice(-STDERR_EXCERPT_LENGTH),
  };

  switch (result.outcome) {
    case 'timeout':
      throw new ProcessTimeoutError(`Process "${result.command}" timed out after ${result.timeoutMs} ms`, { details });
    case 'cancelled':
      throw new ProcessExecutionError(`Process "${result.command}" was cancelled`, { details });
    case 'spawn-error':
      throw new ProcessExecutionError(
        `Process "${result.command}" could not be started: ${result.spawnError?.message ?? 'unknown error'}`,
        { details: { ...details, spawnErrorCode: result.spawnError?.code } },
      );
    case 'non-zero-exit':
      throw new ProcessExecutionError(
        result.exitCode === null
          ? `Process "${result.command}" was terminated by signal ${result.signal ?? 'unknown'}`
          : `Process "${result.command}" exited with code ${result.exitCode}`,
        { details },
      );
  }
}
