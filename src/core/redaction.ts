/**
 * Redaction of credential VALUES in text Forge prints. Environment
 * variables whose names look like credentials (tokens, keys, passwords…)
 * are treated as secrets, and any occurrence of their values in an error
 * message or diagnostic is replaced before it reaches the terminal.
 *
 * This is a safety net for output, not a secret scanner: it only knows the
 * values present in Forge's own environment.
 */

export const REDACTED_VALUE = '[REDACTED]';

const SECRET_NAME = /pass(word|wd)?|secret|token|api[-_]?key|credential|private[-_]?key|auth|cookie|session/i;
/** Very short values would redact ordinary words; real credentials are longer. */
const MIN_SECRET_LENGTH = 8;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Values of credential-like environment variables, longest first (so overlapping values redact fully). */
export function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = Object.entries(env)
    .filter(([name, value]) => isSecretName(name) && value !== undefined && value.trim().length >= MIN_SECRET_LENGTH)
    .map(([, value]) => value!.trim());
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED_VALUE);
  }
  return result;
}
