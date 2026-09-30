import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExecutable } from '../execution/index.ts';
import type { ExecutableResolution, ProcessExecutor, ResolveExecutableOptions, ResolvedExecutable } from '../execution/index.ts';
import { silentLogger } from '../logging/index.ts';
import type { Logger } from '../logging/index.ts';
import {
  CLAUDE_CODE_WORKER_ID,
  CLAUDE_EXECUTABLE_NAME,
  ClaudeCodeWorker,
  REQUIRED_ROLE_OPTIONS,
  buildClaudeRoleArgs,
  findMissingCapabilities,
  interpretRun,
} from '../workers/index.ts';
import type { WorkerHealth } from '../workers/index.ts';
import type { AiProvider, AiRequest, AiResponse } from './types.ts';
import { MAX_AI_OUTPUT_CHARACTERS } from './types.ts';

export interface ClaudeCodeAiProviderOptions {
  readonly runner: ProcessExecutor;
  readonly executable?: string | null;
  readonly logger?: Logger;
  readonly resolve?: (name: string, options?: ResolveExecutableOptions) => Promise<ExecutableResolution>;
}

type Readiness = { readonly ok: true; readonly executable: ResolvedExecutable } | { readonly ok: false; readonly problem: string };

/**
 * Claude Code as a read-only AI role provider (planner, reviewer). Uses the
 * user's existing Claude Code login. Each call runs with no tools, in a
 * fresh empty temporary directory, with all context on stdin — it cannot
 * read or change the project.
 */
export class ClaudeCodeAiProvider implements AiProvider {
  readonly id = CLAUDE_CODE_WORKER_ID;
  readonly displayName = 'Claude Code';

  private readonly options: ClaudeCodeAiProviderOptions;
  private readonly logger: Logger;
  private readiness: Promise<Readiness> | undefined;

  constructor(options: ClaudeCodeAiProviderOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child('ai:claude-code');
  }

  healthCheck(): Promise<WorkerHealth> {
    // Same CLI and login as the implementer worker.
    return new ClaudeCodeWorker({
      runner: this.options.runner,
      executable: this.options.executable ?? null,
      ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
    }).healthCheck();
  }

  async complete(request: AiRequest, options: { readonly signal?: AbortSignal } = {}): Promise<AiResponse> {
    const started = Date.now();
    const failure = (outcome: AiResponse['outcome'], diagnostic: string): AiResponse => ({
      outcome,
      text: null,
      call: this.metadata(Date.now() - started, {}),
      diagnostic,
    });
    if (options.signal?.aborted === true) {
      return failure('cancelled', 'cancelled before the provider was started');
    }
    const readiness = await this.ensureReady();
    if (!readiness.ok) {
      return failure('unavailable', readiness.problem);
    }

    const workdir = await mkdtemp(join(tmpdir(), 'forge-ai-'));
    try {
      this.logger.info('Invoking Claude Code for an AI role', { role: request.role, requestId: request.requestId });
      const run = await this.options.runner.run({
        command: readiness.executable.command,
        args: [...readiness.executable.prefixArgs, ...buildClaudeRoleArgs(request.instructions)],
        cwd: workdir,
        timeoutMs: request.timeoutMs,
        input: request.input,
        maxOutputBytes: 4 * 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const interpreted = interpretRun(run);
      const call = this.metadata(Date.now() - started, interpreted.provider);
      const diagnostic = interpreted.diagnostics[0] ?? null;
      if (interpreted.outcome !== 'success' || interpreted.summary === null) {
        return { outcome: interpreted.outcome === 'success' ? 'invalid-output' : interpreted.outcome, text: null, call, diagnostic };
      }
      if (interpreted.summary.length > MAX_AI_OUTPUT_CHARACTERS) {
        return { outcome: 'invalid-output', text: null, call, diagnostic: `the answer exceeds ${MAX_AI_OUTPUT_CHARACTERS} characters` };
      }
      return { outcome: 'success', text: interpreted.summary, call, diagnostic: null };
    } finally {
      // Forge's own empty scratch directory; nothing of the user's lives here.
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private ensureReady(): Promise<Readiness> {
    this.readiness ??= (async (): Promise<Readiness> => {
      const resolve = this.options.resolve ?? resolveExecutable;
      const resolution = await resolve(this.options.executable ?? CLAUDE_EXECUTABLE_NAME);
      if (!resolution.ok) {
        return { ok: false, problem: `Claude Code is not available: ${resolution.message}` };
      }
      const help = await this.options.runner.run({
        command: resolution.executable.command,
        args: [...resolution.executable.prefixArgs, '--help'],
        cwd: tmpdir(),
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      if (help.outcome !== 'success') {
        return { ok: false, problem: `\`claude --help\` failed (${help.outcome})` };
      }
      const missing = [
        ...findMissingCapabilities(help.stdout),
        ...REQUIRED_ROLE_OPTIONS.filter((option) => !help.stdout.includes(option)),
        ...(help.stdout.includes('dontAsk') ? [] : ['dontAsk']),
      ];
      return missing.length === 0
        ? { ok: true, executable: resolution.executable }
        : { ok: false, problem: `installed Claude Code lacks required options: ${missing.join(', ')}` };
    })();
    return this.readiness;
  }

  private metadata(durationMs: number, provider: Readonly<Record<string, string | number | boolean | null>>): AiResponse['call'] {
    const number = (key: string): number | null => (typeof provider[key] === 'number' ? (provider[key] as number) : null);
    return {
      provider: this.id,
      model: null,
      durationMs: Math.max(0, Math.round(durationMs)),
      costUsd: number('costUsd'),
      inputTokens: number('inputTokens'),
      outputTokens: number('outputTokens'),
    };
  }
}
