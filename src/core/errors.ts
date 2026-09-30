/**
 * Forge error model.
 *
 * Every error Forge raises deliberately is a `ForgeError` with a stable `code`,
 * so callers can branch on category without string-matching messages.
 * `details` carries diagnostic context; it must never contain secrets
 * (e.g. environment values or credentials).
 */

export type ForgeErrorCode =
  | 'CONFIGURATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'PROCESS_EXECUTION_ERROR'
  | 'PROCESS_TIMEOUT'
  | 'PROJECT_ERROR'
  | 'STATE_ERROR'
  | 'STATE_CONFLICT'
  | 'AUTHORIZATION_ERROR';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export interface ForgeErrorOptions {
  readonly details?: ErrorDetails;
  readonly cause?: unknown;
}

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly details: ErrorDetails;

  constructor(code: ForgeErrorCode, message: string, options: ForgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** Forge configuration is missing or invalid. `issues` lists every problem found. */
export class ConfigurationError extends ForgeError {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], options: ForgeErrorOptions = {}) {
    super('CONFIGURATION_ERROR', `Invalid Forge configuration:\n  - ${issues.join('\n  - ')}`, options);
    this.issues = issues;
  }
}

/** Caller-supplied input (arguments, paths, options) is invalid. */
export class ValidationError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('VALIDATION_ERROR', message, options);
  }
}

/** An external process could not be started, failed, or was cancelled. */
export class ProcessExecutionError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('PROCESS_EXECUTION_ERROR', message, options);
  }
}

/** An external process exceeded its timeout and was terminated. */
export class ProcessTimeoutError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('PROCESS_TIMEOUT', message, options);
  }
}

/** A project cannot be registered, found, or trusted (e.g. not a Git work tree, invalid metadata). */
export class ProjectError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('PROJECT_ERROR', message, options);
  }
}

/** Persisted state is unreadable, malformed, or of an unsupported version. Never auto-repaired. */
export class StateError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('STATE_ERROR', message, options);
  }
}

/** A write was refused because the state changed or is locked by another writer. */
export class StateConflictError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('STATE_CONFLICT', message, options);
  }
}

/** A path falls outside the authorized project boundary. */
export class AuthorizationError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super('AUTHORIZATION_ERROR', message, options);
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError;
}
