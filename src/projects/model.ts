import { ValidationError } from '../core/errors.ts';
import { ObjectReader, SchemaViolation } from '../core/validation.ts';

/**
 * Project identity and configuration (`.forge/project.json`).
 * Contains metadata only — never credentials.
 */

export const PROJECT_SCHEMA_VERSION = 1;

/**
 * Administrative status of the project registration (separate from the work
 * lifecycle `phase` in state.json). Registration always creates `active`.
 */
export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface ProjectRecord {
  readonly schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  /** Stable identity (UUID); names and paths may change, the ID does not. */
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Canonical absolute root at registration; used to detect moved/copied metadata. */
  readonly rootPath: string;
  readonly status: ProjectStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const MAX_PROJECT_NAME_LENGTH = 100;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 2_000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function decodeProjectRecord(raw: unknown, isAbsolutePath: (value: string) => boolean): ProjectRecord {
  const r = new ObjectReader(raw, '', [
    'schemaVersion',
    'id',
    'name',
    'description',
    'rootPath',
    'status',
    'createdAt',
    'updatedAt',
  ]);
  if (r.integer('schemaVersion') !== PROJECT_SCHEMA_VERSION) {
    throw new SchemaViolation('schemaVersion', `must be ${PROJECT_SCHEMA_VERSION}`);
  }
  const record: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: r.id('id'),
    name: r.string('name', { maxLength: MAX_PROJECT_NAME_LENGTH }),
    description: r.nullableString('description', { maxLength: MAX_PROJECT_DESCRIPTION_LENGTH }),
    rootPath: r.string('rootPath', { maxLength: 4_096 }),
    status: r.oneOf('status', PROJECT_STATUSES),
    createdAt: r.timestamp('createdAt'),
    updatedAt: r.timestamp('updatedAt'),
  };
  if (!isAbsolutePath(record.rootPath)) {
    throw new SchemaViolation('rootPath', 'must be an absolute path');
  }
  if (CONTROL_CHARACTERS.test(record.name)) {
    throw new SchemaViolation('name', 'must not contain control characters');
  }
  return record;
}

/** Normalizes and validates a user-supplied project name. */
export function normalizeProjectName(input: string): string {
  const name = input.trim();
  if (name.length === 0) {
    throw new ValidationError('Project name must not be empty');
  }
  if (name.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ValidationError(`Project name must be at most ${MAX_PROJECT_NAME_LENGTH} characters`);
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new ValidationError('Project name must not contain control characters');
  }
  return name;
}

/** Normalizes a user-supplied description; blank becomes `null`. */
export function normalizeProjectDescription(input: string | undefined): string | null {
  const description = input?.trim() ?? '';
  if (description.length === 0) {
    return null;
  }
  if (description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
    throw new ValidationError(`Project description must be at most ${MAX_PROJECT_DESCRIPTION_LENGTH} characters`);
  }
  return description;
}
