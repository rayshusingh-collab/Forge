import { MAX_AI_OUTPUT_CHARACTERS } from './types.ts';

/**
 * Extracts the single JSON object an AI role must answer with. The answer
 * must be exactly one JSON object, optionally inside one ```json fence.
 * No Markdown is interpreted and nothing is guessed: anything else — prose,
 * several objects, oversized text — is rejected.
 */
export type JsonExtraction = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

export function extractJsonObject(text: string): JsonExtraction {
  if (text.length > MAX_AI_OUTPUT_CHARACTERS) {
    return { ok: false, problem: `the answer exceeds ${MAX_AI_OUTPUT_CHARACTERS} characters` };
  }
  let body = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*)\n```$/.exec(body);
  if (fenced !== null) {
    body = fenced[1]!.trim();
  }
  if (!body.startsWith('{') || !body.endsWith('}')) {
    return { ok: false, problem: 'the answer is not a single JSON object (the model may have refused or answered in prose)' };
  }
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, problem: 'the answer is not a JSON object' };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, problem: 'the answer is not valid JSON' };
  }
}
