import type { Environment } from '../config/index.ts';
import type { Logger, TextWriter } from '../logging/index.ts';
import type { AiProviderRegistry } from '../ai/index.ts';
import type { WorkerRegistry } from '../workers/index.ts';

/** Process exit codes used by the CLI. */
export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Everything a command needs from the outside world. Injected so commands
 * can be tested without touching the real process, terminal, or environment.
 */
export interface CliContext {
  /** Command output. Diagnostics and logs go to `stderr`. */
  readonly stdout: TextWriter;
  readonly stderr: TextWriter;
  readonly env: Environment;
  readonly cwd: string;
  readonly version: string;
  readonly nodeVersion: string;
  readonly nodeExecutable: string;
  readonly logger: Logger;
  /** Worker registry; defaults to the built-in workers configured from `env`. */
  readonly workers?: WorkerRegistry;
  /** AI role providers (planner, reviewer); defaults to the built-in ones. */
  readonly aiProviders?: AiProviderRegistry;
  /** Aborted when the user interrupts (Ctrl+C); cancels running workers. */
  readonly signal?: AbortSignal;
}

export interface CliCommand {
  readonly name: string;
  /** One-line description shown in `forge --help`. */
  readonly summary: string;
  readonly usage: string;
  run(args: readonly string[], context: CliContext): Promise<ExitCodeValue>;
}
