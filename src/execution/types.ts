/**
 * How a process run ended.
 *
 * - `success`        process exited with code 0
 * - `non-zero-exit`  process exited with a non-zero code, or was killed by a
 *                    signal Forge did not send
 * - `timeout`        Forge terminated the process after its timeout elapsed
 * - `cancelled`      Forge terminated the process because the caller aborted
 * - `spawn-error`    the process could not be started (e.g. executable not found)
 */
export type ProcessOutcome = 'success' | 'non-zero-exit' | 'timeout' | 'cancelled' | 'spawn-error';

export interface ProcessRequest {
  /**
   * Executable to launch. It is started directly, never through a shell, so
   * shell syntax (pipes, globs, `&&`, quoting) is not interpreted.
   */
  readonly command: string;
  /** Arguments passed verbatim to the executable. Do not place secrets here; they are logged. */
  readonly args?: readonly string[];
  /** Absolute path to an existing directory. Required: there is no implicit default. */
  readonly cwd: string;
  /** Overrides the runner's default timeout for this run. */
  readonly timeoutMs?: number;
  /** Variables merged over the current process environment. Values are never logged or returned. */
  readonly env?: Readonly<Record<string, string>>;
  /** Aborting terminates the process and yields a `cancelled` result. */
  readonly signal?: AbortSignal;
}

export interface ProcessSpawnFailure {
  readonly message: string;
  /** System error code such as `ENOENT`, when available. */
  readonly code: string | undefined;
}

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** `null` when the process never started or was ended by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when output exceeded the runner's capture limit and was cut off. */
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly startedAt: Date;
  readonly durationMs: number;
  /** The timeout that applied to this run. */
  readonly timeoutMs: number;
  /** Present only when `outcome` is `spawn-error`. */
  readonly spawnError: ProcessSpawnFailure | undefined;
}
