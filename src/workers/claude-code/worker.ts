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
import type {
  ProviderMetadata,
  Worker,
  WorkerCapabilities,
  WorkerExecuteOptions,
  WorkerHealth,
  WorkerHealthCheck,
  WorkerOutcome,
  WorkerProcessInfo,
  WorkerRequest,
  WorkerResult,
} from '../types.ts';
import { buildClaudeArgs, findMissingCapabilities, parseAuthStatus, parseClaudeVersion } from './command.ts';
import { parseClaudeOutput } from './output.ts';
import type { ClaudeRunReport } from './output.ts';

export const CLAUDE_CODE_WORKER_ID = 'claude-code';

/** Default executable name looked up on PATH when none is configured. */
export const CLAUDE_EXECUTABLE_NAME = 'claude';

/** Per-stream capture limit for a Claude run; the JSON result is far smaller. */
export const CLAUDE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Bound on the cheap local probes (`--version`, `--help`, `auth status`). */
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ClaudeCodeWorkerOptions {
  readonly runner: ProcessExecutor;
  /** Configured absolute path; `null`/absent looks up `claude` on PATH. */
  readonly executable?: string | null;
  /** Optional spending cap per run, passed to Claude as `--max-budget-usd`. */
  readonly maxBudgetUsd?: number;
  readonly logger?: Logger;
  /** Injected for tests. */
  readonly resolve?: (name: string, options?: ResolveExecutableOptions) => Promise<ExecutableResolution>;
}

type Readiness =
  | { readonly ok: true; readonly executable: ResolvedExecutable }
  | { readonly ok: false; readonly problem: string };

/**
 * Worker backed by the user's local Claude Code CLI in headless mode, using
 * the user's existing Claude authentication. Forge never handles API keys.
 */
export class ClaudeCodeWorker implements Worker {
  readonly id = CLAUDE_CODE_WORKER_ID;
  readonly displayName = 'Claude Code';
  readonly capabilities: WorkerCapabilities = { editsFiles: true, runsCommands: false, structuredOutput: true };

  private readonly options: ClaudeCodeWorkerOptions;
  private readonly logger: Logger;
  private readiness: Promise<Readiness> | undefined;

  constructor(options: ClaudeCodeWorkerOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child('worker:claude-code');
  }

  async healthCheck(): Promise<WorkerHealth> {
    const checks: WorkerHealthCheck[] = [];
    const resolution = await this.resolveProgram();
    if (!resolution.ok) {
      checks.push({ name: 'executable', ok: false, detail: resolution.message });
      return this.health(false, null, null, null, checks);
    }
    const executable = resolution.executable;
    checks.push({ name: 'executable', ok: true, detail: executable.source });

    const versionRun = await this.probe(executable, ['--version']);
    const version = versionRun.outcome === 'success' ? parseClaudeVersion(versionRun.stdout) : null;
    checks.push(
      version === null
        ? { name: 'version', ok: false, detail: `could not read version (${describeProbe(versionRun)})` }
        : { name: 'version', ok: true, detail: version },
    );

    const capabilityProblem = await this.checkCapabilities(executable);
    checks.push(
      capabilityProblem === null
        ? { name: 'headless mode', ok: true, detail: 'print mode with JSON output and restricted permissions supported' }
        : { name: 'headless mode', ok: false, detail: capabilityProblem },
    );

    const authRun = await this.probe(executable, ['auth', 'status', '--json']);
    const authenticated = parseAuthStatus(authRun.stdout);
    checks.push(
      authenticated === null
        ? { name: 'authentication', ok: true, detail: 'unknown (could not be determined locally)' }
        : authenticated
          ? { name: 'authentication', ok: true, detail: 'logged in' }
          : { name: 'authentication', ok: false, detail: 'not logged in; run `claude auth login`' },
    );

    const available = version !== null && capabilityProblem === null && authenticated !== false;
    return this.health(available, version, executable.source, authenticated, checks);
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
      diagnostics: fields.diagnostics
        .slice(0, WORKER_RESULT_LIMITS.diagnostics)
        .map((line) => truncate(line, WORKER_RESULT_LIMITS.diagnostic)),
    });
    const failEarly = (outcome: WorkerOutcome, diagnostic: string): WorkerResult =>
      finish({ outcome, summary: null, process: null, provider: {}, diagnostics: [diagnostic] });

    // Defense in depth: requests are built by prepareWorkerRequest, but never
    // run outside the project even if one was constructed some other way.
    if (!isWithin(request.projectRoot, request.workingDirectory)) {
      return failEarly('unavailable', 'Working directory is outside the project root; refusing to run');
    }
    if (options.signal?.aborted === true) {
      return failEarly('cancelled', 'Cancelled before Claude Code was started');
    }

    const readiness = await this.ensureReady();
    if (!readiness.ok) {
      return failEarly('unavailable', readiness.problem);
    }

    const envelope = buildPromptEnvelope(request);
    const args = [
      ...readiness.executable.prefixArgs,
      ...buildClaudeArgs({
        access: request.access,
        instructions: envelope.instructions,
        ...(this.options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: this.options.maxBudgetUsd }),
      }),
    ];

    this.logger.info('Invoking Claude Code', {
      requestId: request.id,
      access: request.access,
      cwd: request.workingDirectory,
      timeoutMs: request.timeoutMs,
    });
    const run = await this.options.runner.run({
      command: readiness.executable.command,
      args,
      cwd: request.workingDirectory,
      timeoutMs: request.timeoutMs,
      input: envelope.message,
      maxOutputBytes: CLAUDE_MAX_OUTPUT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const result = finish(interpretRun(run));
    this.logger.info('Claude Code finished', {
      requestId: request.id,
      outcome: result.outcome,
      durationMs: result.durationMs,
    });
    return result;
  }

  /** Resolution plus capability check, done once per worker instance. */
  private ensureReady(): Promise<Readiness> {
    this.readiness ??= (async (): Promise<Readiness> => {
      const resolution = await this.resolveProgram();
      if (!resolution.ok) {
        return { ok: false, problem: `Claude Code is not available: ${resolution.message}` };
      }
      const problem = await this.checkCapabilities(resolution.executable);
      if (problem !== null) {
        return { ok: false, problem: `Claude Code cannot be used: ${problem}` };
      }
      return { ok: true, executable: resolution.executable };
    })();
    return this.readiness;
  }

  private resolveProgram(): Promise<ExecutableResolution> {
    const resolve = this.options.resolve ?? resolveExecutable;
    return resolve(this.options.executable ?? CLAUDE_EXECUTABLE_NAME);
  }

  private async checkCapabilities(executable: ResolvedExecutable): Promise<string | null> {
    const help = await this.probe(executable, ['--help']);
    if (help.outcome !== 'success') {
      return `\`claude --help\` failed (${describeProbe(help)})`;
    }
    const missing = findMissingCapabilities(help.stdout);
    return missing.length === 0
      ? null
      : `installed version lacks required options: ${missing.join(', ')}. Update Claude Code.`;
  }

  /** Runs a cheap, local, non-AI command. Uses the OS temp directory, not a project. */
  private probe(executable: ResolvedExecutable, args: readonly string[]): Promise<ProcessResult> {
    return this.options.runner.run({
      command: executable.command,
      args: [...executable.prefixArgs, ...args],
      cwd: probeDirectory(),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
    });
  }

  private health(
    available: boolean,
    version: string | null,
    executable: string | null,
    authenticated: boolean | null,
    checks: WorkerHealthCheck[],
  ): WorkerHealth {
    return { workerId: this.id, available, version, executable, authenticated, checks };
  }
}

/** Maps a finished process to a worker outcome. Exported for tests. */
export function interpretRun(run: ProcessResult): Omit<WorkerResult, 'workerId' | 'requestId' | 'startedAt' | 'durationMs'> {
  const processInfo: WorkerProcessInfo = {
    exitCode: run.exitCode,
    signal: run.signal,
    stdoutBytes: Buffer.byteLength(run.stdout),
    stderrBytes: Buffer.byteLength(run.stderr),
    outputTruncated: run.stdoutTruncated || run.stderrTruncated,
  };
  const stderrNote = run.stderr.trim() === '' ? [] : [`stderr: ${excerpt(run.stderr, 500)}`];

  switch (run.outcome) {
    case 'spawn-error':
      return {
        outcome: 'unavailable',
        summary: null,
        process: null,
        provider: {},
        diagnostics: [`Claude Code could not be started: ${run.spawnError?.message ?? 'unknown error'}`],
      };
    case 'timeout':
      return {
        outcome: 'timeout',
        summary: null,
        process: processInfo,
        provider: {},
        diagnostics: [`Claude Code did not finish within ${run.timeoutMs} ms and was stopped`, ...stderrNote],
      };
    case 'cancelled':
      return { outcome: 'cancelled', summary: null, process: processInfo, provider: {}, diagnostics: ['Run was cancelled'] };
    case 'success':
    case 'non-zero-exit':
      break;
  }

  const parsed = parseClaudeOutput(run.stdout);
  if (!parsed.ok) {
    if (run.stdoutTruncated) {
      return {
        outcome: 'invalid-output',
        summary: null,
        process: processInfo,
        provider: {},
        diagnostics: ['Claude Code output exceeded the capture limit', ...stderrNote],
      };
    }
    if (run.outcome === 'non-zero-exit') {
      return {
        outcome: 'failed',
        summary: null,
        process: processInfo,
        provider: {},
        diagnostics: [`Claude Code exited with code ${String(run.exitCode)}`, ...stderrNote],
      };
    }
    return { outcome: 'invalid-output', summary: null, process: processInfo, provider: {}, diagnostics: [parsed.problem] };
  }

  const report = parsed.report;
  const provider = providerMetadata(report);
  if (report.isError || report.subtype !== 'success') {
    const reason = report.errors[0] ?? report.result ?? 'no details';
    return {
      outcome: 'failed',
      summary: report.result,
      process: processInfo,
      provider,
      diagnostics: [`Claude Code reported ${report.subtype}: ${excerpt(reason, 500)}`, ...deniedNote(report)],
    };
  }
  if (run.outcome === 'non-zero-exit') {
    return {
      outcome: 'failed',
      summary: report.result,
      process: processInfo,
      provider,
      diagnostics: [`Claude Code reported success but exited with code ${String(run.exitCode)}`, ...stderrNote],
    };
  }
  if (report.result === null) {
    return { outcome: 'invalid-output', summary: null, process: processInfo, provider, diagnostics: ['Claude Code returned no result text'] };
  }
  return { outcome: 'success', summary: report.result, process: processInfo, provider, diagnostics: deniedNote(report) };
}

function providerMetadata(report: ClaudeRunReport): ProviderMetadata {
  return {
    subtype: report.subtype,
    sessionId: report.sessionId,
    costUsd: report.totalCostUsd,
    turns: report.numTurns,
    apiDurationMs: report.durationApiMs,
    inputTokens: report.inputTokens,
    outputTokens: report.outputTokens,
    permissionDenials: report.permissionDenials.length,
  };
}

function deniedNote(report: ClaudeRunReport): string[] {
  if (report.permissionDenials.length === 0) {
    return [];
  }
  const tools = [...new Set(report.permissionDenials)].join(', ');
  return [`Forge's permission policy denied ${report.permissionDenials.length} tool request(s): ${tools}`];
}

function describeProbe(run: ProcessResult): string {
  if (run.outcome === 'spawn-error') {
    return run.spawnError?.message ?? 'could not start';
  }
  return run.outcome === 'non-zero-exit' ? `exit code ${String(run.exitCode)}` : run.outcome;
}

function probeDirectory(): string {
  // Probes need a real directory but must not run inside any project.
  return tmpdir();
}
