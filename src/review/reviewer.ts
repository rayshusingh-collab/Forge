import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import { DATA_RULES } from '../ai/envelope.ts';
import { extractJsonObject } from '../ai/structured.ts';
import type { AiRequest, AiResponse } from '../ai/types.ts';
import { AI_LIMITS, REVIEW_CONFIDENCE, REVIEW_RECOMMENDATIONS, decodeFinding } from '../state/index.ts';
import type { ReviewConfidence, ReviewFinding, ReviewRecommendation, ReviewStatus } from '../state/index.ts';

/**
 * The reviewer role: qualitative, ADVISORY critique of a task attempt that
 * already passed deterministic validation. It is not validation: it cannot
 * change task status, and Forge derives the review status from the
 * structured findings rather than trusting the model's verdict.
 */

export const REVIEWER_INSTRUCTIONS = [
  'You are the code reviewer for Forge, a local software-development orchestrator.',
  'You review ONE task implementation that has already passed the deterministic checks configured by a human. Those checks are objective evidence; your review is qualitative and advisory.',
  'Look for what tests may miss: misalignment with the task instruction, incomplete implementation, missing tests or edge cases, suspicious shortcuts, scope creep, risky changes, architecture inconsistency, maintainability problems.',
  'Review mainly the task\'s own changes. Files marked MIXED also contain changes made before the task; do not attribute those to the task.',
  '',
  DATA_RULES,
  '',
  'Severity: "info" (observation), "warning" (should be improved), "error" (likely defect or missing requirement), "critical" (serious risk: security, data loss, broken behavior).',
  '',
  'Answer with exactly one JSON object with these fields and no others:',
  '{',
  '  "recommendation": "accept" | "revise" | "reject",',
  '  "confidence": "low" | "medium" | "high",',
  '  "summary": string,',
  '  "findings": [{ "severity": "info" | "warning" | "error" | "critical", "title": string, "detail": string, "paths": string[], "remediation": string | null }]',
  '}',
  `At most ${AI_LIMITS.reviewFindings} findings. Use an empty "findings" array if there is nothing to report.`,
].join('\n');

export interface ParsedReview {
  readonly recommendation: ReviewRecommendation;
  readonly confidence: ReviewConfidence;
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export type ReviewParse = { readonly ok: true; readonly review: ParsedReview } | { readonly ok: false; readonly diagnostic: string };

export function buildReviewerRequest(input: { readonly requestId: string; readonly packet: string; readonly timeoutMs: number }): AiRequest {
  return {
    role: 'reviewer',
    requestId: input.requestId,
    instructions: REVIEWER_INSTRUCTIONS,
    input: `${input.packet}\n\nAnswer now with the JSON object only.`,
    timeoutMs: input.timeoutMs,
  };
}

export function parseReviewResponse(response: AiResponse): ReviewParse {
  if (response.outcome !== 'success' || response.text === null) {
    return { ok: false, diagnostic: response.diagnostic ?? `reviewer ${response.outcome}` };
  }
  const extracted = extractJsonObject(response.text);
  if (!extracted.ok) {
    return { ok: false, diagnostic: `invalid reviewer output: ${extracted.problem}` };
  }
  try {
    const r = new ObjectReader(extracted.value, '', ['recommendation', 'confidence', 'summary', 'findings']);
    return {
      ok: true,
      review: {
        recommendation: r.oneOf('recommendation', REVIEW_RECOMMENDATIONS),
        confidence: r.oneOf('confidence', REVIEW_CONFIDENCE),
        summary: r.string('summary', { maxLength: AI_LIMITS.reviewSummary }),
        findings: r.array('findings', decodeFinding, AI_LIMITS.reviewFindings),
      },
    };
  } catch (error) {
    if (error instanceof SchemaViolation) {
      return { ok: false, diagnostic: `invalid review: ${error.message}` };
    }
    throw error;
  }
}

/** Forge's own, deterministic status from the findings' severities. */
export function deriveReviewStatus(findings: readonly ReviewFinding[]): Extract<ReviewStatus, 'clear' | 'concerns' | 'blocking-concerns'> {
  if (findings.some((finding) => finding.severity === 'error' || finding.severity === 'critical')) {
    return 'blocking-concerns';
  }
  return findings.some((finding) => finding.severity === 'warning') ? 'concerns' : 'clear';
}
