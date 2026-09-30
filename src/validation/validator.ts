import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { resolveExecutable } from '../execution/index.ts';
import type { ExecutableResolution, ProcessExecutor, ProcessResult } from '../execution/index.ts';
import { ProjectPathBoundary } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { EVIDENCE_LIMITS } from '../state/index.ts';
import type { CheckResultRecord, CheckStatus, ValidationRecord, ValidationStatus } from '../state/index.ts';
import { executableForm, profileHash } from './profile.ts';
import type { ValidationCheck, ValidationProfile } from './profile.ts';

/**
 * Deterministic validator. Runs the profile's checks sequentially, in
 * configured order, and returns bounded evidence.
 *
 * Policy (deterministic, tested):
 * - Every check runs, even after a failure, so the evidence is complete.
 * - Cancellation stops immediately; the running check is `cancelled`, the
 *   remaining ones `skipped`.
 * - The overall status is decided by REQUIRED checks only, by priority:
 *   cancelled > configuration-error > execution-error > timed-out > failed > passed.
 *   Optional checks are recorded but never change it.
 * - No AI is involved, and worker output is never consulted.
 *
 * Environment: checks inherit Forge's environment (tools need PATH etc.),
 * plus CI=true, NO_COLOR=1 and FORCE_COLOR=0 for non-interactive, plain
 * output. The environment is never logged or stored. This is not a sandbox:
 * checks run project code, which the worker may have changed.
 */

export interface ValidatorOptions {
  readonly project: LoadedProject;
  readonly runner: ProcessExecutor;
  readonly signal?: AbortSignal;
  readonly clock?: () => Date;
  /** Injected for tests. */
  readonly resolve?: (nameOrPath: string) => Promise<ExecutableResolution>;
}

const CHECK_ENV = { CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' } as const;
const CAPTURE_BYTES = 1024 * 1024;

const STATUS_PRIORITY: readonly ValidationStatus[] = [
  'cancelled',
  'configuration-error',
  'execution-error',
  'timed-out',
  'failed',
];

export async function runValidation(profile: ValidationProfile, options: ValidatorOptions): Promise<ValidationRecord> {
  const clock = options.clock ?? (() => new Date());
  const startedAt = clock().toISOString();
  const results: CheckResultRecord[] = [];
  let cancelled = false;

  for (const check of profile.checks) {
    if (cancelled || options.signal?.aborted === true) {
      cancelled = true;
      results.push(result(check, 'skipped', { diagnostic: 'not run: validation was cancelled' }));
      continue;
    }
    const outcome = await runCheck(check, options);
    results.push(outcome);
    if (outcome.status === 'cancelled') {
      cancelled = true;
    }
  }

  return {
    status: overallStatus(results),
    profileHash: profileHash(profile),
    startedAt,
    finishedAt: clock().toISOString(),
    checks: results,
  };
}

export function overallStatus(results: readonly CheckResultRecord[]): ValidationStatus {
  const required = results.filter((check) => check.required);
  for (const status of STATUS_PRIORITY) {
    if (required.some((check) => check.status === status)) {
      return status;
    }
  }
  // A skipped required check only happens on cancellation.
  return required.some((check) => check.status === 'skipped') ? 'cancelled' : 'passed';
}

async function runCheck(check: ValidationCheck, options: ValidatorOptions): Promise<CheckResultRecord> {
  const root = options.project.layout.root;
  const boundary = new ProjectPathBoundary(root);

  let cwd: string;
  try {
    const authorized = await boundary.authorize(check.cwd);
    const top = relative(root, authorized.resolvedPath).split(sep)[0]?.toLowerCase();
    const isDirectory = await stat(authorized.resolvedPath).then((info) => info.isDirectory()).catch(() => false);
    if (!authorized.exists || !isDirectory || top === '.forge' || top === '.git') {
      return result(check, 'configuration-error', { diagnostic: `working directory "${check.cwd}" is not a usable directory in the project` });
    }
    cwd = authorized.resolvedPath;
  } catch (error) {
    return result(check, 'configuration-error', { diagnostic: `working directory "${check.cwd}": ${message(error)}` });
  }

  const resolution = await resolveCheckExecutable(check, options.project, options.resolve);
  if (!resolution.ok) {
    return result(check, 'configuration-error', { diagnostic: resolution.message });
  }
  const executable = resolution.executable;

  const run = await options.runner.run({
    command: executable.command,
    args: [...executable.prefixArgs, ...check.args],
    cwd,
    env: CHECK_ENV,
    timeoutMs: check.timeoutMs,
    maxOutputBytes: CAPTURE_BYTES,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return fromProcess(check, run, executable.source);
}

/**
 * Resolves a check's program: PATH lookup for bare names, the path itself
 * for absolute paths, and — for project-relative paths — only after the path
 * passes the project boundary (no traversal, no link escapes).
 */
export async function resolveCheckExecutable(
  check: Pick<ValidationCheck, 'executable'>,
  project: LoadedProject,
  resolve: (nameOrPath: string) => Promise<ExecutableResolution> = (name) => resolveExecutable(name),
): Promise<ExecutableResolution> {
  if (executableForm(check.executable) !== 'project-relative') {
    return resolve(check.executable);
  }
  const boundary = new ProjectPathBoundary(project.layout.root);
  try {
    const authorized = await boundary.authorize(check.executable);
    const probe = authorized.exists ? authorized.resolvedPath : authorized.path;
    return resolve(probe);
  } catch (error) {
    return { ok: false, reason: 'invalid', message: `executable "${check.executable}": ${message(error)}` };
  }
}

function fromProcess(check: ValidationCheck, run: ProcessResult, executable: string): CheckResultRecord {
  const truncated = run.stdoutTruncated || run.stderrTruncated;
  switch (run.outcome) {
    case 'success':
      return result(check, 'passed', { exitCode: 0, durationMs: run.durationMs, executable, outputTruncated: truncated });
    case 'non-zero-exit':
      return result(check, 'failed', {
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        executable,
        ...excerpts(run),
        diagnostic: run.exitCode === null ? `terminated by ${run.signal ?? 'signal'}` : `exited with code ${run.exitCode}`,
      });
    case 'timeout':
      return result(check, 'timed-out', {
        durationMs: run.durationMs,
        executable,
        ...excerpts(run),
        diagnostic: `did not finish within ${Math.round(check.timeoutMs / 1000)} s and was stopped`,
      });
    case 'cancelled':
      return result(check, 'cancelled', { durationMs: run.durationMs, executable, ...excerpts(run), diagnostic: 'cancelled' });
    case 'spawn-error':
      return result(check, 'execution-error', { executable, diagnostic: `could not start: ${run.spawnError?.message ?? 'unknown error'}` });
  }
}

function excerpts(run: ProcessResult): Pick<CheckResultRecord, 'stdout' | 'stderr' | 'outputTruncated'> {
  return {
    stdout: tail(run.stdout),
    stderr: tail(run.stderr),
    outputTruncated: run.stdoutTruncated || run.stderrTruncated || run.stdout.length > EVIDENCE_LIMITS.outputExcerpt || run.stderr.length > EVIDENCE_LIMITS.outputExcerpt,
  };
}

/** The last part of the output is usually the most useful (summaries, errors). */
function tail(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.length <= EVIDENCE_LIMITS.outputExcerpt ? trimmed : `…${trimmed.slice(-(EVIDENCE_LIMITS.outputExcerpt - 1))}`;
}

function result(check: ValidationCheck, status: CheckStatus, fields: Partial<CheckResultRecord> = {}): CheckResultRecord {
  const diagnostic = fields.diagnostic ?? null;
  return {
    id: check.id,
    required: check.required,
    status,
    exitCode: fields.exitCode ?? null,
    durationMs: fields.durationMs ?? null,
    executable: fields.executable ?? null,
    stdout: fields.stdout ?? null,
    stderr: fields.stderr ?? null,
    outputTruncated: fields.outputTruncated ?? false,
    diagnostic: diagnostic === null ? null : diagnostic.slice(0, EVIDENCE_LIMITS.diagnostic),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
