import type { AiDecisionEffect, ReviewFinding, ValidationRecord } from '../state/index.ts';
import type { ParsedDecision } from './decider.ts';

/**
 * Forge's own rules for applying an AI decision. The model's verdict is
 * advisory; these deterministic rules decide the EFFECT, and they can only
 * make it more conservative (accept/reject -> escalate), never less.
 *
 * The asymmetry is deliberate. A false accept lets unverified work move
 * forward and be committed; a false reject only costs another bounded,
 * validated repair attempt. So:
 *
 *   accept  -> accepted only with HIGH confidence, passing required
 *              validation, no critical finding, every blocking finding
 *              assessed resolved / not-applicable, no warning-or-worse
 *              finding left unresolved, every outstanding requirement
 *              assessed satisfied, and observable changes since each
 *              outstanding requirement was made. Otherwise escalated.
 *   reject  -> remediation-required with MEDIUM or HIGH confidence and
 *              repair budget left. Otherwise escalated.
 *   escalate, no answer, invalid answer -> escalated.
 */

export interface DecisionFacts {
  readonly findings: readonly ReviewFinding[];
  readonly validation: ValidationRecord | null;
  /** Labels of the outstanding requirements that were presented. */
  readonly requirementLabels: readonly string[];
  /**
   * For each outstanding remediation: how many attributed files changed
   * since the attempt that required it (null when that cannot be measured).
   */
  readonly changesSinceRemediation: readonly (number | null)[];
  /** Why no repair could follow a rejection (budget or attempts used up), or null. */
  readonly repairBlocked: string | null;
}

export interface RuleOutcome {
  readonly effect: AiDecisionEffect;
  /** Set when the rules changed the verdict's natural effect. */
  readonly policyNote: string | null;
}

export function applyDecisionRules(decision: ParsedDecision, facts: DecisionFacts): RuleOutcome {
  switch (decision.verdict) {
    case 'escalate':
      return { effect: 'escalated', policyNote: null };
    case 'reject': {
      if (decision.confidence === 'low') {
        return escalate('a low-confidence rejection is left to a human');
      }
      if (facts.repairBlocked !== null) {
        return escalate(`a rejection could not be repaired (${facts.repairBlocked})`);
      }
      return { effect: 'remediation-required', policyNote: null };
    }
    case 'accept': {
      const problem = acceptanceProblem(decision, facts);
      return problem === null ? { effect: 'accepted', policyNote: null } : escalate(`acceptance refused by Forge: ${problem}`);
    }
  }
}

function acceptanceProblem(decision: ParsedDecision, facts: DecisionFacts): string | null {
  if (decision.confidence !== 'high') {
    return `acceptance requires high confidence (got ${decision.confidence})`;
  }
  if (facts.validation === null || facts.validation.status !== 'passed' || !facts.validation.checks.some((check) => check.required && check.status === 'passed')) {
    return 'required deterministic validation did not pass';
  }
  const assessment = (number: number) => decision.findingAssessments.find((item) => item.finding === number);
  for (const [index, finding] of facts.findings.entries()) {
    const number = index + 1;
    if (finding.severity === 'critical') {
      return `finding ${number} is critical; critical findings are never accepted automatically`;
    }
    const status = assessment(number)?.status;
    if (finding.severity === 'error' && status !== 'resolved' && status !== 'not-applicable') {
      return `blocking finding ${number} is assessed ${status ?? 'not at all'}`;
    }
    if (finding.severity === 'warning' && (status === undefined || status === 'unresolved')) {
      return `finding ${number} is ${status === undefined ? 'not assessed' : 'unresolved'}`;
    }
  }
  for (const label of facts.requirementLabels) {
    const status = decision.requirementAssessments.find((item) => item.requirement === label)?.status;
    if (status !== 'satisfied') {
      return `outstanding requirement ${label} is ${status ?? 'not assessed'}`;
    }
  }
  if (facts.changesSinceRemediation.some((count) => count === 0)) {
    return 'nothing changed since remediation was required, so it cannot have been carried out';
  }
  return null;
}

function escalate(policyNote: string): RuleOutcome {
  return { effect: 'escalated', policyNote };
}
