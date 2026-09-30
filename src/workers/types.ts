import type { WorkerAccessMode } from '../state/index.ts';

/**
 * Provider-independent worker contract. The orchestration layer only sees
 * these types; provider details (CLI flags, output formats) stay inside
 * adapters such as `ClaudeCodeWorker`.
 */

/**
 * - `success`         the worker completed and reported success
 * - `failed`          the worker ran but reported or exited with failure
 * - `timeout`         Forge stopped the worker after the request timeout
 * - `cancelled`       the caller aborted the run
 * - `unavailable`     the worker is not installed, not usable, or misconfigured
 * - `invalid-output`  the worker's output could not be understood
 */
export const WORKER_OUTCOMES = ['success', 'failed', 'timeout', 'cancelled', 'unavailable', 'invalid-output'] as const;
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

declare const authorizedDirectoryBrand: unique symbol;

/**
 * An absolute directory that has passed the project path boundary (lexical
 * and link checks). Only `prepareWorkerRequest` produces values of this type,
 * so a worker cannot be handed an arbitrary directory by accident.
 */
export type AuthorizedDirectory = string & { readonly [authorizedDirectoryBrand]: true };

export interface WorkerCapabilities {
  /** Can create or modify files when given `edit` access. */
  readonly editsFiles: boolean;
  /** Can execute shell commands or programs. */
  readonly runsCommands: boolean;
  /** Returns machine-readable results. */
  readonly structuredOutput: boolean;
}

export interface WorkerRequest {
  /** Unique ID for this run; also used as the attempt/run record ID. */
  readonly id: string;
  readonly projectId: string;
  /** Canonical project root the run is confined to. */
  readonly projectRoot: string;
  readonly workingDirectory: AuthorizedDirectory;
  /** `workingDirectory` relative to the root, `/`-separated; `.` for the root. */
  readonly relativeWorkingDirectory: string;
  /** Instruction for the worker. Plain text; never interpreted by a shell. */
  readonly task: string;
  /** Optional supporting information, kept separate from the task. */
  readonly context: string | null;
  readonly access: WorkerAccessMode;
  readonly timeoutMs: number;
}

export interface WorkerExecuteOptions {
  /** Aborting stops the run and yields a `cancelled` result. */
  readonly signal?: AbortSignal;
}

export interface WorkerHealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface WorkerHealth {
  readonly workerId: string;
  /** True when the worker can be invoked. */
  readonly available: boolean;
  readonly version: string | null;
  /** Resolved program that would be launched. */
  readonly executable: string | null;
  /** `null` when authentication could not be determined without a paid call. */
  readonly authenticated: boolean | null;
  readonly checks: readonly WorkerHealthCheck[];
}

export interface WorkerProcessInfo {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly outputTruncated: boolean;
}

/** Flat provider metadata such as session ID, cost, or token counts. */
export type ProviderMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface WorkerResult {
  readonly workerId: string;
  readonly requestId: string;
  readonly outcome: WorkerOutcome;
  /** The worker's own account of what it did (bounded). Untrusted text. */
  readonly summary: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  /** Absent when no process was started. */
  readonly process: WorkerProcessInfo | null;
  readonly provider: ProviderMetadata;
  /** Human-readable explanations for non-success outcomes (bounded). */
  readonly diagnostics: readonly string[];
}

export interface Worker {
  /** Stable identifier recorded in state, e.g. `claude-code`. */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: WorkerCapabilities;
  /** Checks installation and usability without doing paid work. */
  healthCheck(): Promise<WorkerHealth>;
  /**
   * Runs one request. Resolves with a result for every runtime outcome
   * (including failure, timeout, and cancellation); does not throw for them.
   */
  execute(request: WorkerRequest, options?: WorkerExecuteOptions): Promise<WorkerResult>;
}

/** Limits keeping results bounded regardless of worker output. */
export const WORKER_RESULT_LIMITS = {
  summary: 20_000,
  diagnostic: 1_000,
  diagnostics: 10,
} as const;
