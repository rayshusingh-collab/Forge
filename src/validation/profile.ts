import { createHash } from 'node:crypto';
import { join, posix, win32 } from 'node:path';

import { ValidationConfigError } from '../core/errors.ts';
import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import type { ForgeLayout } from '../projects/index.ts';
import { acquireFileLock, readJsonDocument, serializeJson, upgradeDocument, writeFileAtomic, UnsupportedVersionError } from '../state/index.ts';

/**
 * The project's validation profile: the deterministic checks Forge runs to
 * decide whether a task's result is acceptable.
 *
 * Trust model: this is executable configuration, so only a human changes it,
 * through `forge validation add|remove`. It is stored as Forge control
 * metadata (`.forge/validation.json`), which workers cannot change without
 * detection: edit-enabled runs verify every byte of `.forge/` afterwards, and
 * read-only runs verify this file. Task text and worker output never become
 * commands. Commands are an executable plus an argument array; no shell.
 */

export const VALIDATION_PROFILE_VERSION = 1;
export const VALIDATION_FILE_NAME = 'validation.json';

export const VALIDATION_LIMITS = {
  checks: 20,
  args: 50,
  argLength: 1_000,
  executableLength: 1_000,
  minTimeoutMs: 1_000,
  maxTimeoutMs: 86_400_000,
  defaultTimeoutMs: 600_000,
} as const;

const CHECK_ID = /^[a-z][a-z0-9-]{0,39}$/;
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ValidationCheck {
  /** Stable identifier, e.g. `typecheck`, `test`. */
  readonly id: string;
  /**
   * The program: a bare name found on PATH (e.g. `npm`), an absolute path,
   * or a project-relative path (e.g. `node_modules/.bin/tsc`).
   */
  readonly executable: string;
  readonly args: readonly string[];
  /** Working directory relative to the project root, `/`-separated; `.` for the root. */
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Required checks decide the result; optional checks are recorded only. */
  readonly required: boolean;
}

export interface ValidationProfile {
  readonly schemaVersion: typeof VALIDATION_PROFILE_VERSION;
  readonly checks: readonly ValidationCheck[];
  readonly updatedAt: string | null;
}

export const EMPTY_PROFILE: ValidationProfile = { schemaVersion: VALIDATION_PROFILE_VERSION, checks: [], updatedAt: null };

export type ExecutableForm = 'path-lookup' | 'absolute' | 'project-relative';

export function executableForm(executable: string): ExecutableForm {
  if (win32.isAbsolute(executable) || posix.isAbsolute(executable)) {
    return 'absolute';
  }
  return /[\\/]/.test(executable) ? 'project-relative' : 'path-lookup';
}

/** Validates and normalizes a check (throws `ValidationConfigError`). */
export function normalizeCheck(input: {
  readonly id: string;
  readonly executable: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly required?: boolean;
}): ValidationCheck {
  const id = input.id.trim();
  if (!CHECK_ID.test(id)) {
    throw new ValidationConfigError('Check name must be 1-40 characters: lowercase letters, digits, and "-", starting with a letter');
  }
  const executable = normalizeExecutable(input.executable);
  const args = [...(input.args ?? [])];
  if (args.length > VALIDATION_LIMITS.args) {
    throw new ValidationConfigError(`A check may have at most ${VALIDATION_LIMITS.args} arguments`);
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.length > VALIDATION_LIMITS.argLength) {
      throw new ValidationConfigError(`Invalid argument (NUL character or longer than ${VALIDATION_LIMITS.argLength} characters)`);
    }
  }
  const cwd = normalizeRelativeDirectory(input.cwd ?? '.');
  const timeoutMs = input.timeoutMs ?? VALIDATION_LIMITS.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < VALIDATION_LIMITS.minTimeoutMs || timeoutMs > VALIDATION_LIMITS.maxTimeoutMs) {
    throw new ValidationConfigError(
      `Timeout must be between ${VALIDATION_LIMITS.minTimeoutMs / 1000} and ${VALIDATION_LIMITS.maxTimeoutMs / 1000} seconds`,
    );
  }
  return { id, executable, args, cwd, timeoutMs, required: input.required ?? true };
}

/** Characters that only make sense to a shell; a program path never needs them. */
const SHELL_SYNTAX = /[&|;<>$`"'\r\n]/;

function normalizeExecutable(value: string): string {
  const executable = value.trim();
  if (executable === '' || executable.includes('\0') || executable.length > VALIDATION_LIMITS.executableLength) {
    throw new ValidationConfigError('Executable must be a program name or path');
  }
  if (SHELL_SYNTAX.test(executable)) {
    throw new ValidationConfigError(
      `"${executable}" looks like shell syntax; give only the program, and pass its arguments separately (commands never run through a shell)`,
    );
  }
  switch (executableForm(executable)) {
    case 'absolute':
      return executable;
    case 'path-lookup':
      if (!BARE_NAME.test(executable)) {
        throw new ValidationConfigError(`"${executable}" is not a plain program name; shell syntax is not supported`);
      }
      return executable;
    case 'project-relative':
      return normalizeRelativePath(executable, 'Executable path');
  }
}

function normalizeRelativeDirectory(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' || trimmed === '.' || trimmed === './' ? '.' : normalizeRelativePath(trimmed, 'Working directory');
}

/** Project-relative, `/`-separated, inside the project, never into `.forge` or `.git`. */
function normalizeRelativePath(value: string, label: string): string {
  if (win32.isAbsolute(value) || posix.isAbsolute(value) || value.includes('\0')) {
    throw new ValidationConfigError(`${label} must be relative to the project root`);
  }
  const normalized = posix.normalize(value.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/$/, '');
  const segments = normalized.split('/');
  if (normalized === '..' || segments[0] === '..' || segments.includes('..')) {
    throw new ValidationConfigError(`${label} must stay inside the project`);
  }
  if (['.forge', '.git'].includes(segments[0]!.toLowerCase())) {
    throw new ValidationConfigError(`${label} must not be inside .forge/ or .git/`);
  }
  return normalized === '' ? '.' : normalized;
}

export function decodeValidationProfile(raw: unknown): ValidationProfile {
  const r = new ObjectReader(raw, '', ['schemaVersion', 'checks', 'updatedAt']);
  if (r.integer('schemaVersion') !== VALIDATION_PROFILE_VERSION) {
    throw new SchemaViolation('schemaVersion', `must be ${VALIDATION_PROFILE_VERSION}`);
  }
  const checks = r.array('checks', decodeCheck, VALIDATION_LIMITS.checks);
  const ids = new Set<string>();
  checks.forEach((check, index) => {
    if (ids.has(check.id)) {
      throw new SchemaViolation(`checks[${index}].id`, `duplicates "${check.id}"`);
    }
    ids.add(check.id);
  });
  return { schemaVersion: VALIDATION_PROFILE_VERSION, checks, updatedAt: r.nullableTimestamp('updatedAt') };
}

function decodeCheck(value: unknown, path: string): ValidationCheck {
  const r = new ObjectReader(value, path, ['id', 'executable', 'args', 'cwd', 'timeoutMs', 'required']);
  const raw = {
    id: r.string('id', { maxLength: 40 }),
    executable: r.string('executable', { maxLength: VALIDATION_LIMITS.executableLength }),
    args: r.array('args', (item, itemPath) => {
      if (typeof item !== 'string') {
        throw new SchemaViolation(itemPath, 'must be a string');
      }
      return item;
    }, VALIDATION_LIMITS.args),
    cwd: r.string('cwd', { maxLength: 1_000 }),
    timeoutMs: r.integer('timeoutMs'),
    required: r.field('required', (item, itemPath) => {
      if (typeof item !== 'boolean') {
        throw new SchemaViolation(itemPath, 'must be true or false');
      }
      return item;
    }),
  };
  let check: ValidationCheck;
  try {
    check = normalizeCheck(raw);
  } catch (error) {
    throw new SchemaViolation(path, `is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Stored checks must already be in normalized form.
  if (check.executable !== raw.executable || check.cwd !== raw.cwd) {
    throw new SchemaViolation(path, 'is not in normalized form');
  }
  return check;
}

/** SHA-256 over the checks, identifying exactly which configuration produced a validation result. */
export function profileHash(profile: ValidationProfile): string {
  return createHash('sha256').update(JSON.stringify(profile.checks)).digest('hex');
}

/**
 * Reads and writes `.forge/validation.json`. Writes take the project state
 * lock, so they cannot interleave with an edit-enabled task (which holds it
 * for its whole run) and are therefore never mistaken for tampering.
 */
export class ValidationProfileStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly clock: () => Date;

  constructor(layout: ForgeLayout, options: { readonly clock?: () => Date } = {}) {
    this.file = join(layout.forgeDir, VALIDATION_FILE_NAME);
    this.lockFile = layout.lockFile;
    this.clock = options.clock ?? (() => new Date());
  }

  async load(): Promise<ValidationProfile> {
    let raw: unknown;
    try {
      raw = await readJsonDocument(this.file, 'Validation profile');
    } catch (error) {
      throw new ValidationConfigError(`Validation profile is unreadable: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (raw === undefined) {
      return EMPTY_PROFILE;
    }
    try {
      return decodeValidationProfile(upgradeDocument(raw, VALIDATION_PROFILE_VERSION));
    } catch (error) {
      if (error instanceof SchemaViolation || error instanceof UnsupportedVersionError) {
        throw new ValidationConfigError(`Validation profile is invalid (${this.file}): ${error.message}`, { cause: error });
      }
      throw error;
    }
  }

  async addCheck(check: ValidationCheck): Promise<ValidationProfile> {
    return this.change((profile) => {
      if (profile.checks.some((existing) => existing.id === check.id)) {
        throw new ValidationConfigError(`A check named "${check.id}" already exists; remove it first`);
      }
      if (profile.checks.length >= VALIDATION_LIMITS.checks) {
        throw new ValidationConfigError(`At most ${VALIDATION_LIMITS.checks} checks are supported`);
      }
      return [...profile.checks, check];
    });
  }

  async removeCheck(id: string): Promise<ValidationProfile> {
    return this.change((profile) => {
      if (!profile.checks.some((existing) => existing.id === id)) {
        throw new ValidationConfigError(`No check named "${id}"`);
      }
      return profile.checks.filter((existing) => existing.id !== id);
    });
  }

  private async change(update: (profile: ValidationProfile) => ValidationCheck[]): Promise<ValidationProfile> {
    const lock = await acquireFileLock(this.lockFile, { timeoutMs: 5_000 });
    try {
      const current = await this.load();
      const next: ValidationProfile = {
        schemaVersion: VALIDATION_PROFILE_VERSION,
        checks: update(current),
        updatedAt: this.clock().toISOString(),
      };
      decodeValidationProfile(JSON.parse(JSON.stringify(next)) as unknown);
      await writeFileAtomic(this.file, serializeJson(next));
      return next;
    } finally {
      await lock.release();
    }
  }
}
