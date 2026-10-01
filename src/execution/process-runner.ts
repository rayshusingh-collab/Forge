import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ValidationError } from '../core/errors.ts';
import { silentLogger } from '../logging/index.ts';
import type { Logger } from '../logging/index.ts';
import type { ProcessExecutor, ProcessOutcome, ProcessRequest, ProcessResult, ProcessSpawnFailure } from './types.ts';

export interface ProcessRunnerOptions {
  /** Timeout applied when a request does not specify one. */
  readonly defaultTimeoutMs: number;
  /**
   * After a graceful termination request (SIGTERM), how long to wait before
   * forcing termination (SIGKILL). On Windows both map to TerminateProcess.
   */
  readonly killGraceMs?: number;
  /** Per-stream capture limit; output beyond it is discarded and flagged as truncated. */
  readonly maxOutputBytes?: number;
  readonly logger?: Logger;
}

export const DEFAULT_KILL_GRACE_MS = 2_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The single controlled entry point for launching external processes.
 *
 * Processes are started without a shell, in an explicit and validated working
 * directory, with stdin closed, captured output, and a mandatory timeout.
 * Process-level failures (non-zero exit, timeout, cancellation, spawn failure)
 * are reported in the returned `ProcessResult` rather than thrown; only an
 * invalid request throws (`ValidationError`). Use `assertProcessSucceeded`
 * when a failure should become an exception.
 */
export class ProcessRunner implements ProcessExecutor {
  private readonly defaultTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;
  private readonly logger: Logger;

  constructor(options: ProcessRunnerOptions) {
    assertPositiveInteger(options.defaultTimeoutMs, 'defaultTimeoutMs');
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    assertPositiveInteger(this.killGraceMs, 'killGraceMs');
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    assertPositiveInteger(this.maxOutputBytes, 'maxOutputBytes');
    this.logger = (options.logger ?? silentLogger).child('execution');
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const args = [...(request.args ?? [])];
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    validateCommand(request.command, args);
    assertPositiveInteger(timeoutMs, 'timeoutMs');
    if (request.maxOutputBytes !== undefined) {
      assertPositiveInteger(request.maxOutputBytes, 'maxOutputBytes');
    }
    if (request.input !== undefined && typeof request.input !== 'string') {
      throw new ValidationError('Process input must be a string');
    }
    await validateWorkingDirectory(request.cwd);

    const base = { command: request.command, args, cwd: request.cwd, timeoutMs };
    this.logger.debug('Starting process', { command: base.command, args, cwd: base.cwd, timeoutMs });

    const result = await this.execute(request, base);

    const summary = { command: result.command, outcome: result.outcome, exitCode: result.exitCode, durationMs: result.durationMs };
    if (result.outcome === 'success') {
      this.logger.debug('Process finished', summary);
    } else if (result.outcome === 'non-zero-exit') {
      // Often an expected answer (e.g. a probe command); callers decide whether it is a failure.
      this.logger.debug('Process exited unsuccessfully', summary);
    } else if (result.outcome === 'spawn-error') {
      this.logger.warn('Process could not be started', { ...summary, error: result.spawnError?.message });
    } else {
      this.logger.warn('Process was terminated', summary);
    }
    return result;
  }

  private execute(
    request: ProcessRequest,
    base: Pick<ProcessResult, 'command' | 'args' | 'cwd' | 'timeoutMs'>,
  ): Promise<ProcessResult> {
    const startedAt = new Date();
    const startTime = performance.now();

    const finalize = (fields: {
      outcome: ProcessOutcome;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stdout?: OutputCollector;
      stderr?: OutputCollector;
      spawnError?: ProcessSpawnFailure;
    }): ProcessResult => ({
      ...base,
      outcome: fields.outcome,
      exitCode: fields.exitCode ?? null,
      signal: fields.signal ?? null,
      stdout: fields.stdout?.text() ?? '',
      stderr: fields.stderr?.text() ?? '',
      stdoutTruncated: fields.stdout?.truncated ?? false,
      stderrTruncated: fields.stderr?.truncated ?? false,
      startedAt,
      durationMs: Math.round(performance.now() - startTime),
      spawnError: fields.spawnError,
    });

    if (request.signal?.aborted === true) {
      return Promise.resolve(finalize({ outcome: 'cancelled' }));
    }

    let child: ChildProcess;
    try {
      child = spawn(request.command, base.args, {
        cwd: base.cwd,
        env: { ...process.env, ...request.env },
        shell: false,
        // stdin stays closed unless input is supplied, so no child can block waiting for it.
        stdio: [request.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      // Some failures (e.g. EINVAL for .cmd/.bat files on Windows) throw synchronously.
      return Promise.resolve(finalize({ outcome: 'spawn-error', spawnError: toSpawnFailure(error) }));
    }

    return new Promise<ProcessResult>((resolve) => {
      const outputLimit = request.maxOutputBytes ?? this.maxOutputBytes;
      const stdout = new OutputCollector(outputLimit);
      const stderr = new OutputCollector(outputLimit);

      if (request.input !== undefined && child.stdin !== null) {
        // A child that exits without reading its input raises EPIPE; the
        // process outcome already describes what happened.
        child.stdin.on('error', () => undefined);
        child.stdin.end(request.input, 'utf8');
      }
      const timers: NodeJS.Timeout[] = [];
      let settled = false;
      let terminationReason: 'timeout' | 'cancelled' | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

      const settle = (result: ProcessResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        timers.forEach(clearTimeout);
        request.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const terminate = (reason: 'timeout' | 'cancelled'): void => {
        if (terminationReason !== undefined || settled) {
          return;
        }
        terminationReason = reason;
        if (process.platform === 'win32' && child.pid !== undefined) {
          // Windows does not signal descendants: an agent CLI's own child processes (e.g. the
          // shell commands a Codex worker runs) would survive and keep changing files after
          // Forge recorded the outcome. Terminate the whole tree FIRST — taskkill can only
          // find descendants while the root is still alive — then the direct kill follows.
          void killProcessTree(child.pid).then(() => child.kill('SIGTERM'));
        } else {
          child.kill('SIGTERM');
        }
        timers.push(
          setTimeout(() => {
            child.kill('SIGKILL');
            // If a descendant process inherited the output pipes, 'close' may
            // never fire even though our child is gone. Stop waiting rather
            // than hang the caller.
            timers.push(
              setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                settle(finalize({ outcome: reason, exitCode, signal: exitSignal, stdout, stderr }));
              }, this.killGraceMs),
            );
          }, this.killGraceMs),
        );
      };

      const onAbort = (): void => terminate('cancelled');
      request.signal?.addEventListener('abort', onAbort, { once: true });
      timers.push(setTimeout(() => terminate('timeout'), base.timeoutMs));

      child.once('error', (error) => {
        // After a successful spawn, 'error' only signals a failed kill or
        // message send; 'close' still follows, so only spawn failures settle here.
        if (child.pid === undefined) {
          settle(finalize({ outcome: 'spawn-error', stdout, stderr, spawnError: toSpawnFailure(error) }));
        }
      });

      child.once('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });

      child.once('close', (code, signal) => {
        const outcome: ProcessOutcome = terminationReason ?? (code === 0 ? 'success' : 'non-zero-exit');
        settle(finalize({ outcome, exitCode: code, signal, stdout, stderr }));
      });
    });
  }
}

class OutputCollector {
  private readonly chunks: Buffer[] = [];
  private readonly limit: number;
  private size = 0;
  truncated = false;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    const remaining = this.limit - this.size;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.truncated ||= kept.length < chunk.length;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  /** Decoded once at the end so multi-byte characters split across chunks survive. */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function validateCommand(command: string, args: readonly string[]): void {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new ValidationError('Process command must be a non-empty string');
  }
  if (command.includes('\0')) {
    throw new ValidationError('Process command must not contain NUL characters');
  }
  args.forEach((arg, index) => {
    if (typeof arg !== 'string') {
      throw new ValidationError(`Process argument ${index} must be a string`);
    }
    if (arg.includes('\0')) {
      throw new ValidationError(`Process argument ${index} must not contain NUL characters`);
    }
  });
}

async function validateWorkingDirectory(cwd: string): Promise<void> {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new ValidationError('Process working directory must be provided');
  }
  if (!isAbsolute(cwd)) {
    throw new ValidationError('Process working directory must be an absolute path', { details: { cwd } });
  }
  let isDirectory: boolean;
  try {
    isDirectory = (await stat(cwd)).isDirectory();
  } catch (error) {
    throw new ValidationError('Process working directory does not exist', { details: { cwd }, cause: error });
  }
  if (!isDirectory) {
    throw new ValidationError('Process working directory is not a directory', { details: { cwd } });
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${name} must be a positive integer`, { details: { [name]: value } });
  }
}

function toSpawnFailure(error: unknown): ProcessSpawnFailure {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { message: error.message, code: typeof code === 'string' ? code : undefined };
  }
  return { message: String(error), code: undefined };
}

/**
 * Terminates a process and all of its descendants on Windows using the
 * system's own `taskkill` (fixed absolute path, fixed arguments, no shell).
 * Resolves when taskkill has finished (or after a short bound); best effort,
 * because the direct kill and the SIGKILL backstop still follow.
 */
function killProcessTree(pid: number): Promise<void> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
  return new Promise((resolve) => {
    const done = (): void => resolve();
    try {
      const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', done);
      killer.once('exit', done);
      setTimeout(done, TREE_KILL_BOUND_MS).unref();
    } catch {
      done();
    }
  });
}

/** Upper bound on waiting for taskkill before the direct kill proceeds anyway. */
const TREE_KILL_BOUND_MS = 5_000;
