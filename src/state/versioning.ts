import { SchemaViolation, decodeInteger, isPlainObject } from '../core/validation.ts';

/**
 * Reads `schemaVersion` from an untrusted document before anything else, so a
 * document from another version is never decoded with the wrong schema.
 */
export function readSchemaVersion(raw: unknown): number {
  if (!isPlainObject(raw)) {
    throw new SchemaViolation('(root)', 'must be an object');
  }
  return decodeInteger(raw['schemaVersion'], 'schemaVersion', { min: 1 });
}

export class UnsupportedVersionError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      found > supported
        ? `schema version ${found} is newer than this Forge supports (${supported}); upgrade Forge`
        : `schema version ${found} is no longer supported (current: ${supported}) and no migration exists`,
    );
    this.name = 'UnsupportedVersionError';
    this.found = found;
    this.supported = supported;
  }
}

/**
 * Migration boundary. Today only the current version is accepted. When a
 * schema changes, register a step here that converts version N to N+1; steps
 * run in order until the document reaches `current`, then it is decoded.
 */
export type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

export function upgradeDocument(
  raw: unknown,
  current: number,
  migrations: Readonly<Record<number, Migration>> = {},
): unknown {
  let version = readSchemaVersion(raw);
  let document = raw as Record<string, unknown>;
  while (version < current) {
    const migrate = migrations[version];
    if (migrate === undefined) {
      break;
    }
    document = migrate(document);
    version = readSchemaVersion(document);
  }
  if (version !== current) {
    throw new UnsupportedVersionError(version, current);
  }
  return document;
}
