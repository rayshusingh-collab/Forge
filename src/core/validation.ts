/**
 * Minimal runtime validation for untrusted JSON (e.g. files under `.forge/`).
 *
 * TypeScript types say nothing about what is actually on disk, so every
 * persisted document is decoded field by field. Decoding stops at the first
 * problem and reports its location as a JSON-style path (`tasks[2].status`).
 * Unknown fields are rejected so hand-edited or foreign data is not silently
 * accepted.
 */

export class SchemaViolation extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`${path} ${problem}`);
    this.name = 'SchemaViolation';
    this.path = path;
  }
}

export type Decoder<T> = (value: unknown, path: string) => T;

export interface StringRules {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  /** Human-readable description of `pattern`, used in errors. */
  readonly patternDescription?: string;
}

export interface IntegerRules {
  readonly min?: number;
  readonly max?: number;
}

/** Record identifiers: UUIDs today, room for readable prefixes later. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Timestamps are always UTC ISO-8601 as produced by `Date#toISOString`. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function decodeString(value: unknown, path: string, rules: StringRules = {}): string {
  if (typeof value !== 'string') {
    throw new SchemaViolation(path, 'must be a string');
  }
  const { minLength = 1, maxLength = 10_000 } = rules;
  if (value.length < minLength) {
    throw new SchemaViolation(path, minLength === 1 ? 'must not be empty' : `must be at least ${minLength} characters`);
  }
  if (value.length > maxLength) {
    throw new SchemaViolation(path, `must be at most ${maxLength} characters`);
  }
  if (rules.pattern !== undefined && !rules.pattern.test(value)) {
    throw new SchemaViolation(path, `must be ${rules.patternDescription ?? `match ${String(rules.pattern)}`}`);
  }
  return value;
}

export function decodeInteger(value: unknown, path: string, rules: IntegerRules = {}): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new SchemaViolation(path, 'must be an integer');
  }
  if (rules.min !== undefined && value < rules.min) {
    throw new SchemaViolation(path, `must be >= ${rules.min}`);
  }
  if (rules.max !== undefined && value > rules.max) {
    throw new SchemaViolation(path, `must be <= ${rules.max}`);
  }
  return value;
}

export function decodeOneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new SchemaViolation(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function decodeTimestamp(value: unknown, path: string): string {
  const text = decodeString(value, path, {
    pattern: TIMESTAMP_PATTERN,
    patternDescription: 'a UTC ISO-8601 timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)',
  });
  if (Number.isNaN(Date.parse(text))) {
    throw new SchemaViolation(path, 'must be a valid date');
  }
  return text;
}

export function decodeId(value: unknown, path: string): string {
  return decodeString(value, path, {
    pattern: ID_PATTERN,
    patternDescription: 'an identifier of 1-64 letters, digits, "_" or "-"',
  });
}

/**
 * Typed field access for one JSON object. Construction verifies the value is
 * an object containing no fields outside `allowedKeys`.
 */
export class ObjectReader {
  readonly path: string;
  private readonly value: Record<string, unknown>;

  constructor(value: unknown, path: string, allowedKeys: readonly string[]) {
    if (!isPlainObject(value)) {
      throw new SchemaViolation(path, 'must be an object');
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) {
        throw new SchemaViolation(this.childPath(path, key), 'is not a recognised field');
      }
    }
    this.path = path;
    this.value = value;
  }

  string(key: string, rules?: StringRules): string {
    return decodeString(this.required(key), this.at(key), rules);
  }

  nullableString(key: string, rules?: StringRules): string | null {
    const value = this.required(key);
    return value === null ? null : decodeString(value, this.at(key), rules);
  }

  integer(key: string, rules?: IntegerRules): number {
    return decodeInteger(this.required(key), this.at(key), rules);
  }

  oneOf<T extends string>(key: string, allowed: readonly T[]): T {
    return decodeOneOf(this.required(key), this.at(key), allowed);
  }

  id(key: string): string {
    return decodeId(this.required(key), this.at(key));
  }

  nullableId(key: string): string | null {
    const value = this.required(key);
    return value === null ? null : decodeId(value, this.at(key));
  }

  timestamp(key: string): string {
    return decodeTimestamp(this.required(key), this.at(key));
  }

  nullableTimestamp(key: string): string | null {
    const value = this.required(key);
    return value === null ? null : decodeTimestamp(value, this.at(key));
  }

  /** A required field decoded by `decode` (e.g. a nested object). */
  field<T>(key: string, decode: Decoder<T>): T {
    return decode(this.required(key), this.at(key));
  }

  nullable<T>(key: string, decode: Decoder<T>): T | null {
    const value = this.required(key);
    return value === null ? null : decode(value, this.at(key));
  }

  array<T>(key: string, decode: Decoder<T>, maxItems = 10_000): T[] {
    const value = this.required(key);
    const path = this.at(key);
    if (!Array.isArray(value)) {
      throw new SchemaViolation(path, 'must be an array');
    }
    if (value.length > maxItems) {
      throw new SchemaViolation(path, `must contain at most ${maxItems} items`);
    }
    return value.map((item, index) => decode(item, `${path}[${index}]`));
  }

  /** Every field is required; optional values are represented as explicit `null`. */
  private required(key: string): unknown {
    if (!Object.hasOwn(this.value, key)) {
      throw new SchemaViolation(this.at(key), 'is required');
    }
    return this.value[key];
  }

  private at(key: string): string {
    return this.childPath(this.path, key);
  }

  private childPath(path: string, key: string): string {
    return path === '' ? key : `${path}.${key}`;
  }
}
