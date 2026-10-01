import { createHash } from 'node:crypto';

/**
 * Deterministic hashing of plain JSON-like values: object keys are sorted,
 * so equal content always yields the same digest regardless of key order.
 * Used for policy hashes and approval fingerprints.
 */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function fingerprintOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
