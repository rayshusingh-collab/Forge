import { isAbsolute } from 'node:path';

import { ConfigurationError } from '../core/errors.ts';
import { LOG_LEVELS, isLogLevel } from '../logging/index.ts';
import type { LogLevel } from '../logging/index.ts';

export const RUNTIME_MODES = ['development', 'production', 'test'] as const;

export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export interface ForgeConfig {
  readonly logLevel: LogLevel;
  /** Default timeout applied to external processes that do not specify one. */
  readonly processTimeoutMs: number;
  readonly mode: RuntimeMode;
  /** Default timeout for an AI worker run (much longer than ordinary processes). */
  readonly workerTimeoutMs: number;
  /**
   * Absolute path to the Claude Code executable, or `null` to look up
   * `claude` on PATH. Only configurable here, never from task input.
   */
  readonly claudeExecutable: string | null;
  /**
   * Absolute path to the Codex CLI executable, or `null` to look up
   * `codex` on PATH. Only configurable here, never from task input.
   */
  readonly codexExecutable: string | null;
}

/** Environment variables Forge reads. Kept in one place so docs and code agree. */
export const ENV_VARS = {
  logLevel: 'FORGE_LOG_LEVEL',
  processTimeoutMs: 'FORGE_PROCESS_TIMEOUT_MS',
  mode: 'FORGE_ENV',
  workerTimeoutMs: 'FORGE_WORKER_TIMEOUT_MS',
  claudeExecutable: 'FORGE_CLAUDE_EXECUTABLE',
  codexExecutable: 'FORGE_CODEX_EXECUTABLE',
} as const;

export const DEFAULT_CONFIG: ForgeConfig = Object.freeze({
  logLevel: 'info',
  processTimeoutMs: 120_000,
  mode: 'production',
  workerTimeoutMs: 600_000,
  claudeExecutable: null,
  codexExecutable: null,
});

/** Upper bound on the default timeout (24h) so a typo cannot disable timeouts in practice. */
export const MAX_PROCESS_TIMEOUT_MS = 86_400_000;

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Builds a validated, immutable configuration from environment variables.
 *
 * Unset or blank variables fall back to defaults. All problems are collected
 * and reported together in a single `ConfigurationError`.
 */
export function loadConfig(env: Environment = process.env): ForgeConfig {
  const issues: string[] = [];

  const logLevel = readEnum(env, ENV_VARS.logLevel, LOG_LEVELS, isLogLevel, DEFAULT_CONFIG.logLevel, issues);
  const mode = readEnum(env, ENV_VARS.mode, RUNTIME_MODES, isRuntimeMode, DEFAULT_CONFIG.mode, issues);
  const processTimeoutMs = readInteger(
    env,
    ENV_VARS.processTimeoutMs,
    { min: 1, max: MAX_PROCESS_TIMEOUT_MS },
    DEFAULT_CONFIG.processTimeoutMs,
    issues,
  );

  const workerTimeoutMs = readInteger(
    env,
    ENV_VARS.workerTimeoutMs,
    { min: 1, max: MAX_PROCESS_TIMEOUT_MS },
    DEFAULT_CONFIG.workerTimeoutMs,
    issues,
  );
  const claudeExecutable = readAbsolutePath(env, ENV_VARS.claudeExecutable, issues);
  const codexExecutable = readAbsolutePath(env, ENV_VARS.codexExecutable, issues);

  if (issues.length > 0) {
    throw new ConfigurationError(issues);
  }

  return Object.freeze({ logLevel, processTimeoutMs, mode, workerTimeoutMs, claudeExecutable, codexExecutable });
}

function isRuntimeMode(value: string): value is RuntimeMode {
  return (RUNTIME_MODES as readonly string[]).includes(value);
}

function readRaw(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readEnum<T extends string>(
  env: Environment,
  name: string,
  allowed: readonly T[],
  guard: (value: string) => value is T,
  fallback: T,
  issues: string[],
): T {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.toLowerCase();
  if (guard(normalized)) {
    return normalized;
  }
  issues.push(`${name} must be one of: ${allowed.join(', ')} (received "${raw}")`);
  return fallback;
}

function readInteger(
  env: Environment,
  name: string,
  bounds: { readonly min: number; readonly max: number },
  fallback: number,
  issues: string[],
): number {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    return fallback;
  }
  // Digits only: rejects "1e3", "10.5", "-1", "12ms" and other ambiguous forms.
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    issues.push(`${name} must be an integer between ${bounds.min} and ${bounds.max} (received "${raw}")`);
    return fallback;
  }
  return value;
}

function readAbsolutePath(env: Environment, name: string, issues: string[]): string | null {
  const raw = readRaw(env, name);
  if (raw === undefined) {
    return null;
  }
  if (raw.includes('\0') || !isAbsolute(raw)) {
    issues.push(`${name} must be an absolute path (received "${raw}")`);
    return null;
  }
  return raw;
}
