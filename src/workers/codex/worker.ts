import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { resolveExecutable } from '../../execution/index.ts';
import type { ExecutableResolution, ProcessExecutor, ProcessResult, ResolveExecutableOptions, ResolvedExecutable } from '../../execution/index.ts';
import { silentLogger } from '../../logging/index.ts';
import type { Logger } from '../../logging/index.ts';
import { isWithin } from '../../projects/index.ts';
import { buildPromptEnvelope } from '../prompt-envelope.ts';
import { excerpt, truncate } from '../text.ts';
import { WORKER_RESULT_LIMITS } from '../types.ts';
import type { ProviderMetadata, Worker, WorkerCapabilities, WorkerExecuteOptions, WorkerHealth, WorkerHealthCheck, WorkerOutcome, WorkerProcessInfo, WorkerRequest, WorkerResult } from '../types.ts';
import { buildCodexExecArgs, findMissingCodexCapabilities, parseCodexLoginStatus, parseCodexVersion } from './command.ts';
import { parseCodexEvents } from './output.ts';

export const CODEX_WORKER_ID = 'codex';

/** Default executable name looked up on PATH when none is configured (`FORGE_CODEX_EXECUTABLE`). */
export const CODEX_EXECUTABLE_NAME = 'codex';

/** Per-stream capture limit; the JSONL event stream includes command output summaries. */
export const CODEX_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export interface CodexWorkerOptions {
  readonly runner: ProcessExecutor;
  /** Configured absolute path; `null`/absent looks up `codex` on PATH. */
  readonly executable?: string | null;
  readonly logger?: Logger;
  /** Injected for tests. */
  readonly resolve?: (name: string, options?: ResolveExecutableOptions) => Promise<ExecutableResolution>;
}

type Readiness = { readonly ok: true; readonly executable: ResolvedExecutable } | { readonly ok: false; readonly problem: string };

/**
 * Worker backed by the user's installed, already-authenticated OpenAI Codex
 * CLI (`codex exec`). Forge never handles OpenAI keys or logins; Codex's own
 * authentication is used as-is. Invocation and sandbox mapping: see
 * `command.ts`. Unlike the Claude worker, Codex runs model-generated shell
 * commands, inside its own sandbox (no network, writes only in the working
 * directory). Forge's own checks (integrity, scope, validation, safe commit)
 * apply exactly as for any worker.
 */
export class CodexWorker implements Worker {
  readonly id = CODEX_WORKER_ID;
  readonly displayName = 'Codex CLI';
  readonly capabilities: WorkerCapabilities = { editsFiles: true, runsCommands: true, structuredOutput: true };

  private readonly options: CodexWorkerOptions;
  private readonly logger: Logger;
  private readiness: Promise<Readiness> | undefined;

  constructor(options: CodexWorkerOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child('worker:codex');
  }

  async healthCheck(): Promise<WorkerHealth> {
    const checks: WorkerHealthCheck[] = [];
    const resolution = await this.resolveProgram();
    if (!resolution.ok) {
      checks.push({ name: 'executable', ok: false, detail: resolution.message });
      return { workerId: this.id, available: false, version: null, executable: null, authenticated: null, checks };
    }
    const executable = resolution.executable;
    checks.push({ name: 'executable', ok: true, detail: executable.source });

    const versionRun = await probe(this.options.runner, executable, ['--version']);
    const version = versionRun.outcome === 'success' ? parseCodexVersion(versionRun.stdout) : null;
    checks.push(version === null ? { name: 'version', ok: false, detail: `could not read version (${describeProbe(versionRun)})` } : { name: 'version', ok: true, detail: version });

    const capabilityProblem = await checkCodexCapabilities(this.options.runner, executable);
    checks.push(
      capabilityProblem === null
        ? { name: 'non-interactive mode', ok: true, detail: '`codex exec` with JSON events, sandbox modes and config isolation supported' }
        : { name: 'non-interactive mode', ok: false, detail: capabilityProblem },
    );

    const loginRun = await probe(this.options.runner, executable, ['login', 'status']);
    // Only the verdict is used; Codex's output is never stored or printed.
    const authenticated = loginRun.outcome === 'spawn-error' ? null : parseCodexLoginStatus(loginRun.exitCode, `${loginRun.stdout}\n${loginRun.stderr}`);
    checks.push(
      authenticated === null
        ? { name: 'authentication', ok: true, detail: 'unknown (could not be determined locally)' }
        : authenticated
          ? { name: 'authentication', ok: true, detail: 'logged in (according to `codex login status`)' }
          : { name: 'authentication', ok: false, detail: 'not logged in; run `codex login` yourself (Forge never handles credentials)' },
    );

    const available = version !== null && capabilityProblem === null && authenticated !== false;
    return { workerId: this.id, available, version, executable: executable.source, authenticated, checks };
  }

  async execute(request: WorkerRequest, options: WorkerExecuteOptions = {}): Promise<WorkerResult> {
    const startedAt = new Date();
    const startTime = performance.now();
    const finish = (fields: Omit<WorkerResult, 'workerId' | 'requestId' | 'startedAt' | 'durationMs'>): WorkerResult => ({
      workerId: this.id,
      requestId: request.id,
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - startTime),
      ...fields,
      summary: fields.summary === null ? null : truncate(fields.summary, WORKER_RESULT_LIMITS.summary),
      diagnostics: fields.diagnostics.slice(0, WORKER_RESULT_LIMITS.diagnostics).map((line) => truncate(line, WORKER_RESULT_LIMITS.diagnostic)),
    });
    const failEarly = (outcome: WorkerOutcome, diagnostic: string): WorkerResult =>
      finish({ outcome, summary: null, process: null, provider: {}, diagnostics: [diagnostic] });

    // Defense in depth: never run outside the project, even for a hand-built request.
    if (!isWithin(request.projectRoot, request.workingDirectory)) {
      return failEarly('unavailable', 'Working directory is outside the project root; refusing to run');
    }
    if (options.signal?.aborted === true) {
      return failEarly('cancelled', 'Cancelled before Codex was started');
    }
    const readiness = await this.ensureReady();
    if (!readiness.ok) {
      return failEarly('unavailable', readiness.problem);
    }

    // Codex has no separate system-prompt channel: Forge's rules come first, then the fenced task data.
    const envelope = buildPromptEnvelope(request);
    this.logger.info('Invoking Codex', { requestId: request.id, access: request.access, cwd: request.workingDirectory, timeoutMs: request.timeoutMs });
    const run = await this.options.runner.run({
      command: readiness.executable.command,
      args: [...readiness.executable.prefixArgs, ...buildCodexExecArgs({ kind: 'worker', access: request.access, workingDirectory: request.workingDirectory })],
      cwd: request.workingDirectory,
      timeoutMs: request.timeoutMs,
      input: `${envelope.instructions}\n\n${envelope.message}\n`,
      maxOutputBytes: CODEX_MAX_OUTPUT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const result = finish(interpretCodexRun(run));
    this.logger.info('Codex finished', { requestId: request.id, outcome: result.outcome, durationMs: result.durationMs });
    return result;
  }

  private ensureReady(): Promise<Readiness> {
    this.readiness ??= (async (): Promise<Readiness> => {
      const resolution = await this.resolveProgram();
      if (!resolution.ok) {
        return { ok: false, problem: `Codex is not available: ${resolution.message}` };
      }
      const problem = await checkCodexCapabilities(this.options.runner, resolution.executable);
      return problem === null ? { ok: true, executable: resolution.executable } : { ok: false, problem: `Codex cannot be used: ${problem}` };
    })();
    return this.readiness;
  }

  private resolveProgram(): Promise<ExecutableResolution> {
    return (this.options.resolve ?? resolveExecutable)(this.options.executable ?? CODEX_EXECUTABLE_NAME);
  }
}

/** Checks `codex exec --help` for every option Forge's invocation relies on. */
export async function checkCodexCapabilities(runner: ProcessExecutor, executable: ResolvedExecutable): Promise<string | null> {
  const help = await probe(runner, executable, ['exec', '--help']);
  if (help.outcome !== 'success') {
    return `\`codex exec --help\` failed (${describeProbe(help)})`;
  }
  const missing = findMissingCodexCapabilities(help.stdout);
  return missing.length === 0 ? null : `installed version lacks required options: ${missing.join(', ')}. Update Codex.`;
}

/** Maps a finished `codex exec --json` process to a worker outcome. Exported for tests and the AI-role provider. */
export function interpretCodexRun(run: ProcessResult): Omit<WorkerResult, 'workerId' | 'requestId' | 'startedAt' | 'durationMs'> {
  const processInfo: WorkerProcessInfo = {
    exitCode: run.exitCode,
    signal: run.signal,
    stdoutBytes: Buffer.byteLength(run.stdout),
    stderrBytes: Buffer.byteLength(run.stderr),
    outputTruncated: run.stdoutTruncated || run.stderrTruncated,
  };
  // Codex logs routine noise on stderr; it is only quoted when the run failed.
  const stderrNote = run.stderr.trim() === '' ? [] : [`stderr: ${excerpt(run.stderr, 500)}`];
  const result = (outcome: WorkerOutcome, summary: string | null, provider: ProviderMetadata, diagnostics: string[]) => ({
    outcome,
    summary,
    process: outcome === 'unavailable' ? null : processInfo,
    provider,
    diagnostics,
  });

  switch (run.outcome) {
    case 'spawn-error':
      return result('unavailable', null, {}, [`Codex could not be started: ${run.spawnError?.message ?? 'unknown error'}`]);
    case 'timeout':
      return result('timeout', null, {}, [`Codex did not finish within ${run.timeoutMs} ms and was stopped`]);
    case 'cancelled':
      return result('cancelled', null, {}, ['Run was cancelled']);
    case 'success':
    case 'non-zero-exit':
      break;
  }

  const parsed = parseCodexEvents(run.stdout);
  if (!parsed.ok) {
    if (run.stdoutTruncated) {
      return result('invalid-output', null, {}, ['Codex output exceeded the capture limit', ...stderrNote]);
    }
    if (run.outcome === 'non-zero-exit') {
      return result('failed', null, {}, [`Codex exited with code ${String(run.exitCode)}`, ...stderrNote]);
    }
    return result('invalid-output', null, {}, [parsed.problem]);
  }
  const report = parsed.report;
  const provider: ProviderMetadata = {
    sessionId: report.threadId,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    fileChanges: report.fileChanges,
    commands: report.commands,
  };
  if (report.status === 'failed') {
    return result('failed', null, provider, [`Codex reported a failed turn: ${excerpt(report.error ?? 'no details', 500)}`]);
  }
  if (run.outcome === 'non-zero-exit') {
    return result('failed', report.message, provider, [`Codex exited with code ${String(run.exitCode)}${report.error === null ? '' : `: ${excerpt(report.error, 400)}`}`]);
  }
  if (report.status !== 'completed') {
    return result('invalid-output', null, provider, ['Codex exited without completing its turn']);
  }
  if (report.message === null || report.message.trim() === '') {
    return result('invalid-output', null, provider, ['Codex returned no final message']);
  }
  return result('success', report.message, provider, []);
}

function probe(runner: ProcessExecutor, executable: ResolvedExecutable, args: readonly string[]): Promise<ProcessResult> {
  // Cheap local commands only; run in the OS temp directory, never in a project.
  return runner.run({
    command: executable.command,
    args: [...executable.prefixArgs, ...args],
    cwd: tmpdir(),
    timeoutMs: PROBE_TIMEOUT_MS,
    maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
  });
}

function describeProbe(run: ProcessResult): string {
  if (run.outcome === 'spawn-error') {
    return run.spawnError?.message ?? 'could not start';
  }
  return run.outcome === 'non-zero-exit' ? `exit code ${String(run.exitCode)}` : run.outcome;
}
