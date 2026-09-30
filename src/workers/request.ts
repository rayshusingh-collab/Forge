import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { AuthorizationError, ValidationError } from '../core/errors.ts';
import { FORGE_DIR_NAME, ProjectPathBoundary } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import type { WorkerAccessMode } from '../state/index.ts';
import type { AuthorizedDirectory, WorkerRequest } from './types.ts';

export const WORKER_REQUEST_LIMITS = {
  taskCharacters: 20_000,
  contextCharacters: 50_000,
  /** 24 hours; matches the configuration ceiling. */
  maxTimeoutMs: 86_400_000,
} as const;

export interface PrepareWorkerRequestInput {
  readonly project: LoadedProject;
  readonly task: string;
  readonly context?: string | null;
  /**
   * Directory to run in: absolute, or relative to the project root.
   * Defaults to the project root.
   */
  readonly workingDirectory?: string;
  readonly access: WorkerAccessMode;
  readonly timeoutMs: number;
  /** Injected for tests; defaults to a random UUID. */
  readonly id?: string;
}

/** Directories inside a project that a worker must never run in. */
const FORBIDDEN_TOP_LEVEL = [FORGE_DIR_NAME, '.git'];

/**
 * The only way to build a `WorkerRequest`: validates text limits and the
 * timeout, then authorizes the working directory through the project's path
 * boundary (rejecting traversal, outside paths, and link/junction escapes).
 */
export async function prepareWorkerRequest(input: PrepareWorkerRequestInput): Promise<WorkerRequest> {
  const task = validateText(input.task, 'Task', WORKER_REQUEST_LIMITS.taskCharacters);
  if (task === null) {
    throw new ValidationError('Task must not be empty');
  }
  const context =
    input.context === undefined || input.context === null
      ? null
      : validateText(input.context, 'Context', WORKER_REQUEST_LIMITS.contextCharacters);

  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > WORKER_REQUEST_LIMITS.maxTimeoutMs) {
    throw new ValidationError(`Worker timeout must be an integer between 1 and ${WORKER_REQUEST_LIMITS.maxTimeoutMs} ms`, {
      details: { timeoutMs: input.timeoutMs },
    });
  }

  const root = input.project.layout.root;
  const boundary = new ProjectPathBoundary(root);
  const authorized = await boundary.authorize(input.workingDirectory ?? '.');

  const isDirectory = await stat(authorized.resolvedPath).then((info) => info.isDirectory()).catch(() => false);
  if (!authorized.exists || !isDirectory) {
    throw new ValidationError('Worker working directory must be an existing directory inside the project', {
      details: { workingDirectory: authorized.path },
    });
  }

  // Measured on the resolved path (the root is canonical), so a link that stays
  // inside the project but points into .git or .forge is still caught.
  const resolvedRelative = relative(root, authorized.resolvedPath);
  const segments = resolvedRelative === '' ? [] : resolvedRelative.split(sep);
  const topLevel = segments[0]?.toLowerCase();
  if (topLevel !== undefined && FORBIDDEN_TOP_LEVEL.includes(topLevel)) {
    throw new AuthorizationError(`Workers may not run inside ${segments[0]}/`, {
      details: { workingDirectory: authorized.path },
    });
  }

  return {
    id: input.id ?? randomUUID(),
    projectId: input.project.project.id,
    projectRoot: root,
    workingDirectory: authorized.resolvedPath as AuthorizedDirectory,
    relativeWorkingDirectory: segments.length === 0 ? '.' : segments.join('/'),
    task,
    context,
    access: input.access,
    timeoutMs: input.timeoutMs,
  };
}

/** Trims; returns null when blank. Rejects NUL characters and oversized text. */
function validateText(value: string, label: string, maxCharacters: number): string | null {
  if (typeof value !== 'string') {
    throw new ValidationError(`${label} must be text`);
  }
  if (value.includes('\0')) {
    throw new ValidationError(`${label} must not contain NUL characters`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxCharacters) {
    throw new ValidationError(`${label} is too long (${trimmed.length} characters; limit ${maxCharacters})`);
  }
  return trimmed === '' ? null : trimmed;
}
