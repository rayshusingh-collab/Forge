import { DATA_RULES } from '../ai/envelope.ts';
import { extractJsonObject } from '../ai/structured.ts';
import type { AiRequest, AiResponse } from '../ai/types.ts';
import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import { AI_DECISION_VERDICTS, AI_LIMITS, FINDING_ASSESSMENTS, REQUIREMENT_ASSESSMENTS, REVIEW_CONFIDENCE } from '../state/index.ts';
import type { AiDecisionVerdict, FindingAssessment, RequirementAssessment, ReviewConfidence } from '../state/index.ts';

/**
 * The decision-maker role: given Forge's evidence about ONE validated
 * attempt and the AI review of it, judge whether the work should be
 * accepted, sent back for remediation, or handed to a human.
 *
 * It is not the reviewer (which finds problems) and not validation (which is
 * deterministic and already passed). Its answer is advisory input: Forge
 * validates it strictly here and then applies its own, stricter rules
 * (`rules.ts`) before anything changes.
 */

export const DECISION_MAKER_INSTRUCTIONS = [
  'You are the engineering decision-maker for Forge, a local software-development orchestrator.',
  'An implementer (another AI) worked on ONE task. Forge ran the project\'s configured deterministic checks and they PASSED. An AI reviewer then reviewed the work and raised concerns.',
  'Your job is NOT to review the code again. Your job is to JUDGE, from the evidence, whether the work should be accepted, sent back for remediation, or escalated to a human.',
  '',
  'Evidence hierarchy (strongest first):',
  '1. Forge\'s deterministic evidence: which checks ran and their results, and the actual Git-attributed changes (file list and diffs).',
  '2. The reviewer\'s findings: ADVISORY. They may be wrong or overstated. Evaluate each one against the evidence yourself; do not simply follow the reviewer\'s recommendation.',
  '3. The implementer\'s summary: an UNTRUSTED CLAIM. It is never evidence. "Tests pass", "added tests", "verified", "fixed", or "no changes were needed" prove nothing by themselves.',
  'A claim is supported only if the deterministic evidence or the actual changes show it. Examples:',
  '- The worker says tests passed, but no check that runs tests is configured or ran: NOT proven.',
  '- The worker says it added tests, but the changes contain no test file: NOT proven.',
  '- Remediation required an observable artifact (tests, docs, a code change) and the changes since that requirement do not contain it: NOT satisfied.',
  '',
  'Outstanding remediation requirements (labelled R1, R2, …) were required by an earlier decision. Assess EVERY one: "satisfied" only with concrete evidence in the changes or check results; "unsatisfied" when the evidence shows it is missing; "unverifiable" when the evidence cannot show it either way.',
  'Assess EVERY reviewer finding of severity warning, error or critical (by its number): "resolved", "unresolved", "not-applicable" (the finding is wrong or irrelevant), or "acceptable" (real but minor enough to accept).',
  '',
  'Decide:',
  '- "accept" only when the evidence supports that the task is done: every outstanding requirement is satisfied, no blocking problem is unresolved, and you are confident. Acceptance lets the work move forward and be committed, so it needs the strongest evidence.',
  '- "reject" when concrete, fixable work remains (for example missing tests, an unmet requirement, a defect). Give "requiredActions": specific, observable, verifiable remediation steps for the implementer. Rejection triggers another bounded repair attempt.',
  '- "escalate" when a human must decide: product or requirement ambiguity, a choice between valid designs that needs the product owner, major scope expansion, anything security- or credential-sensitive, destructive operations, or evidence too weak or contradictory to decide. Give "humanReason": what the human must decide and why.',
  'Use confidence honestly: "high" only when the evidence is clear. Low-confidence decisions are escalated by Forge.',
  '',
  DATA_RULES,
  '',
  'Answer with exactly one JSON object with these fields and no others:',
  '{',
  '  "decision": "accept" | "reject" | "escalate",',
  '  "confidence": "low" | "medium" | "high",',
  '  "reason": string,',
  '  "findingAssessments": [{ "finding": number, "status": "resolved" | "unresolved" | "not-applicable" | "acceptable", "note": string }],',
  '  "requirementAssessments": [{ "requirement": "R1", "status": "satisfied" | "unsatisfied" | "unverifiable", "evidence": string }],',
  '  "requiredActions": string[],',
  '  "humanReason": string | null',
  '}',
  `"requiredActions" must be non-empty (at most ${AI_LIMITS.remediationRequirements}) exactly when the decision is "reject", otherwise []. "humanReason" must be a string exactly when the decision is "escalate", otherwise null.`,
].join('\n');

export interface ParsedDecision {
  readonly verdict: AiDecisionVerdict;
  readonly confidence: ReviewConfidence;
  readonly reason: string;
  readonly findingAssessments: readonly FindingAssessment[];
  readonly requirementAssessments: readonly RequirementAssessment[];
  readonly requiredActions: readonly string[];
  readonly humanReason: string | null;
}

export type DecisionParse = { readonly ok: true; readonly decision: ParsedDecision } | { readonly ok: false; readonly diagnostic: string };

/** What the answer must cover: the reviewer findings that need an assessment and the requirement labels presented. */
export interface DecisionExpectations {
  /** 1-based numbers of the findings with severity warning or above. */
  readonly findingsToAssess: readonly number[];
  readonly findingCount: number;
  readonly requirementLabels: readonly string[];
}

export function buildDecisionRequest(input: { readonly requestId: string; readonly packet: string; readonly timeoutMs: number }): AiRequest {
  return {
    role: 'decision-maker',
    requestId: input.requestId,
    instructions: DECISION_MAKER_INSTRUCTIONS,
    input: `${input.packet}\n\nAnswer now with the JSON object only.`,
    timeoutMs: input.timeoutMs,
  };
}

/**
 * Strict parsing. Anything that is not exactly the required object — wrong
 * types, missing or extra fields, unknown finding numbers or requirement
 * labels, an assessment missing for a required finding or requirement, or
 * inconsistent reject/escalate fields — is invalid and can only escalate.
 */
export function parseDecisionResponse(response: AiResponse, expected: DecisionExpectations): DecisionParse {
  if (response.outcome !== 'success' || response.text === null) {
    return { ok: false, diagnostic: response.diagnostic ?? `decision-maker ${response.outcome}` };
  }
  const extracted = extractJsonObject(response.text);
  if (!extracted.ok) {
    return { ok: false, diagnostic: `invalid decision output: ${extracted.problem}` };
  }
  try {
    const r = new ObjectReader(extracted.value, '', ['decision', 'confidence', 'reason', 'findingAssessments', 'requirementAssessments', 'requiredActions', 'humanReason']);
    const decision: ParsedDecision = {
      verdict: r.oneOf('decision', AI_DECISION_VERDICTS),
      confidence: r.oneOf('confidence', REVIEW_CONFIDENCE),
      reason: r.string('reason', { maxLength: AI_LIMITS.decisionReason }),
      findingAssessments: r.array('findingAssessments', decodeFindingAssessment, AI_LIMITS.reviewFindings),
      requirementAssessments: r.array('requirementAssessments', decodeRequirementAssessment, AI_LIMITS.remediationRequirements * 10),
      requiredActions: r.array('requiredActions', decodeAction, AI_LIMITS.remediationRequirements),
      humanReason: r.nullableString('humanReason', { maxLength: AI_LIMITS.decisionReason }),
    };
    const problem = coverageProblem(decision, expected);
    return problem === null ? { ok: true, decision } : { ok: false, diagnostic: `invalid decision: ${problem}` };
  } catch (error) {
    if (error instanceof SchemaViolation) {
      return { ok: false, diagnostic: `invalid decision: ${error.message}` };
    }
    throw error;
  }
}

function coverageProblem(decision: ParsedDecision, expected: DecisionExpectations): string | null {
  const numbers = decision.findingAssessments.map((assessment) => assessment.finding);
  if (new Set(numbers).size !== numbers.length) {
    return 'a finding is assessed more than once';
  }
  const unknown = numbers.find((number) => number > expected.findingCount);
  if (unknown !== undefined) {
    return `finding ${unknown} does not exist`;
  }
  const missing = expected.findingsToAssess.find((number) => !numbers.includes(number));
  if (missing !== undefined) {
    return `finding ${missing} is not assessed`;
  }
  const labels = decision.requirementAssessments.map((assessment) => assessment.requirement);
  if (new Set(labels).size !== labels.length) {
    return 'a requirement is assessed more than once';
  }
  const unknownLabel = labels.find((label) => !expected.requirementLabels.includes(label));
  if (unknownLabel !== undefined) {
    return `requirement ${unknownLabel} does not exist`;
  }
  const missingLabel = expected.requirementLabels.find((label) => !labels.includes(label));
  if (missingLabel !== undefined) {
    return `requirement ${missingLabel} is not assessed`;
  }
  if ((decision.verdict === 'reject') !== (decision.requiredActions.length > 0)) {
    return '"requiredActions" must be non-empty exactly for a reject decision';
  }
  if ((decision.verdict === 'escalate') !== (decision.humanReason !== null && decision.humanReason.trim() !== '')) {
    return '"humanReason" must be given exactly for an escalate decision';
  }
  if (decision.reason.trim() === '') {
    return '"reason" must not be empty';
  }
  return null;
}

function decodeFindingAssessment(value: unknown, path: string): FindingAssessment {
  const r = new ObjectReader(value, path, ['finding', 'status', 'note']);
  return {
    finding: r.integer('finding', { min: 1, max: AI_LIMITS.reviewFindings }),
    status: r.oneOf('status', FINDING_ASSESSMENTS),
    note: r.string('note', { minLength: 0, maxLength: AI_LIMITS.assessmentNote }),
  };
}

function decodeRequirementAssessment(value: unknown, path: string): RequirementAssessment {
  const r = new ObjectReader(value, path, ['requirement', 'status', 'evidence']);
  return {
    requirement: r.string('requirement', { maxLength: 8 }),
    status: r.oneOf('status', REQUIREMENT_ASSESSMENTS),
    evidence: r.string('evidence', { minLength: 0, maxLength: AI_LIMITS.assessmentNote }),
  };
}

function decodeAction(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > AI_LIMITS.requirementText) {
    throw new SchemaViolation(path, `must be a non-empty string of at most ${AI_LIMITS.requirementText} characters`);
  }
  return value.trim();
}
