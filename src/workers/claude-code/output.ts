import { isPlainObject } from '../../core/validation.ts';

/**
 * Parses the single JSON document printed by `claude --print
 * --output-format=json`. The output is untrusted: required fields are checked
 * strictly; optional metadata with an unexpected shape is dropped rather
 * than trusted; unknown fields are ignored so newer CLI versions still work.
 */

export interface ClaudeRunReport {
  /** e.g. `success`, `error_max_turns`, `error_during_execution`. */
  readonly subtype: string;
  readonly isError: boolean;
  readonly result: string | null;
  readonly sessionId: string | null;
  readonly totalCostUsd: number | null;
  readonly numTurns: number | null;
  readonly durationApiMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Names of tools Claude tried to use but was denied (bounded). */
  readonly permissionDenials: readonly string[];
  /** Error messages reported by Claude (bounded). */
  readonly errors: readonly string[];
}

export type ClaudeOutputParse =
  | { readonly ok: true; readonly report: ClaudeRunReport }
  | { readonly ok: false; readonly problem: string };

const MAX_LIST_ITEMS = 20;
const MAX_ITEM_LENGTH = 500;

export function parseClaudeOutput(stdout: string): ClaudeOutputParse {
  const document = parseJsonDocument(stdout);
  if (document === undefined) {
    return { ok: false, problem: stdout.trim() === '' ? 'Claude produced no output' : 'Claude output is not valid JSON' };
  }
  if (!isPlainObject(document)) {
    return { ok: false, problem: 'Claude output is not a JSON object' };
  }
  if (document['type'] !== 'result') {
    return { ok: false, problem: 'Claude output is not a result message' };
  }
  const subtype = document['subtype'];
  if (typeof subtype !== 'string' || subtype === '' || subtype.length > 100) {
    return { ok: false, problem: 'Claude output has no valid "subtype"' };
  }
  const isError = document['is_error'];
  if (typeof isError !== 'boolean') {
    return { ok: false, problem: 'Claude output has no valid "is_error"' };
  }
  const result = document['result'];
  if (result !== undefined && result !== null && typeof result !== 'string') {
    return { ok: false, problem: 'Claude output "result" is not text' };
  }

  const usage = isPlainObject(document['usage']) ? document['usage'] : {};
  return {
    ok: true,
    report: {
      subtype,
      isError,
      result: typeof result === 'string' ? result : null,
      sessionId: optionalString(document['session_id'], /^[A-Za-z0-9_-]{1,100}$/),
      totalCostUsd: optionalNumber(document['total_cost_usd']),
      numTurns: optionalInteger(document['num_turns']),
      durationApiMs: optionalInteger(document['duration_api_ms']),
      inputTokens: optionalInteger(usage['input_tokens']),
      outputTokens: optionalInteger(usage['output_tokens']),
      permissionDenials: listOf(document['permission_denials'], (item) =>
        isPlainObject(item) && typeof item['tool_name'] === 'string' ? item['tool_name'] : undefined,
      ),
      errors: listOf(document['errors'], (item) => (typeof item === 'string' ? item : undefined)),
    },
  };
}

/** Accepts the whole output as JSON, or else its last line that looks like a JSON object. */
function parseJsonDocument(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return undefined;
  }
  const candidates = [trimmed];
  const lastLine = trimmed.split(/\r?\n/).at(-1)?.trim();
  if (lastLine !== undefined && lastLine !== trimmed && lastLine.startsWith('{')) {
    candidates.push(lastLine);
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function optionalString(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function listOf(value: unknown, pick: (item: unknown) => string | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: string[] = [];
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    const picked = pick(item);
    if (picked !== undefined) {
      items.push(picked.slice(0, MAX_ITEM_LENGTH));
    }
  }
  return items;
}
