import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveExecutable } from '../execution/index.ts';
import type { ExecutableResolution, ProcessExecutor, ResolveExecutableOptions, ResolvedExecutable } from '../execution/index.ts';
import { silentLogger } from '../logging/index.ts';
import type { Logger } from '../logging/index.ts';
import { CODEX_EXECUTABLE_NAME, CODEX_MAX_OUTPUT_BYTES, CODEX_WORKER_ID, CodexWorker, buildCodexExecArgs, checkCodexCapabilities, interpretCodexRun } from '../workers/index.ts';
import type { WorkerHealth } from '../workers/index.ts';
import type { AiProvider, AiRequest, AiResponse } from './types.ts';
import { MAX_AI_OUTPUT_CHARACTERS } from './types.ts';

export interface CodexAiProviderOptions {
  readonly runner: ProcessExecutor;
  readonly executable?: string | null;
  readonly logger?: Logger;
  readonly resolve?: (name: string, options?: ResolveExecutableOptions) => Promise<ExecutableResolution>;
}

type Readiness = { readonly ok: true; readonly executable: ResolvedExecutable } | { readonly ok: false; readonly problem: string };

/**
 * Codex CLI as a read-only AI role provider (planner, reviewer), using the
 * user's existing Codex login. Each call runs in a fresh, empty temporary
 * directory with a read-only sandbox and command execution disabled, so the
 * model works only from the input Forge sends on stdin. The answer goes
 * through exactly the same strict parsing as any other provider's.
 *
 * Codex has no separate system-prompt channel: Forge's role instructions are
 * placed first in the input, followed by the fenced data blocks.
 */
export class CodexAiProvider implements AiProvider {
  readonly id = CODEX_WORKER_ID;
  readonly displayName = 'Codex CLI';

  private readonly options: CodexAiProviderOptions;
  private readonly logger: Logger;
  private readiness: Promise<Readiness> | undefined;

  constructor(options: CodexAiProviderOptions) {
    this.options = options;
    this.logger = (options.logger ?? silentLogger).child('ai:codex');
  }

  healthCheck(): Promise<WorkerHealth> {
    // Same CLI and login as the Codex worker.
    return new CodexWorker({
      runner: this.options.runner,
      executable: this.options.executable ?? null,
      ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
    }).healthCheck();
  }

  async complete(request: AiRequest, options: { readonly signal?: AbortSignal } = {}): Promise<AiResponse> {
    const started = Date.now();
    const failure = (outcome: AiResponse['outcome'], diagnostic: string): AiResponse => ({ outcome, text: null, call: this.metadata(Date.now() - started, {}), diagnostic });
    if (options.signal?.aborted === true) {
      return failure('cancelled', 'cancelled before the provider was started');
    }
    const readiness = await this.ensureReady();
    if (!readiness.ok) {
      return failure('unavailable', readiness.problem);
    }

    const workdir = await mkdtemp(join(tmpdir(), 'forge-ai-'));
    try {
      this.logger.info('Invoking Codex for an AI role', { role: request.role, requestId: request.requestId });
      const run = await this.options.runner.run({
        command: readiness.executable.command,
        args: [...readiness.executable.prefixArgs, ...buildCodexExecArgs({ kind: 'role', workingDirectory: workdir })],
        cwd: workdir,
        timeoutMs: request.timeoutMs,
        input: `${request.instructions}\n\n${request.input}\n`,
        maxOutputBytes: CODEX_MAX_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const interpreted = interpretCodexRun(run);
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
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private ensureReady(): Promise<Readiness> {
    this.readiness ??= (async (): Promise<Readiness> => {
      const resolution = await (this.options.resolve ?? resolveExecutable)(this.options.executable ?? CODEX_EXECUTABLE_NAME);
      if (!resolution.ok) {
        return { ok: false, problem: `Codex is not available: ${resolution.message}` };
      }
      const problem = await checkCodexCapabilities(this.options.runner, resolution.executable);
      return problem === null ? { ok: true, executable: resolution.executable } : { ok: false, problem: `Codex cannot be used: ${problem}` };
    })();
    return this.readiness;
  }

  private metadata(durationMs: number, provider: Readonly<Record<string, string | number | boolean | null>>): AiResponse['call'] {
    const number = (key: string): number | null => (typeof provider[key] === 'number' ? (provider[key] as number) : null);
    // Codex's event stream reports no model identifier and no cost; neither is invented.
    return { provider: this.id, model: null, durationMs: Math.max(0, Math.round(durationMs)), costUsd: null, inputTokens: number('inputTokens'), outputTokens: number('outputTokens') };
  }
}
