import { randomUUID } from 'node:crypto';

import { runReadOnly } from '../ai/read-only-guard.ts';
import type { AiProvider } from '../ai/types.ts';
import { assertNotPaused } from '../control/pause.ts';
import { redactSecrets, secretValues } from '../core/redaction.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import { openStateStore } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { expandedLimits } from '../review/index.ts';
import type { ReviewPacketLimits } from '../review/index.ts';
import { AI_LIMITS, implementationAttempts } from '../state/index.ts';
import type { AiDecisionRecord, AiDecisionStatus, StateStore, TaskRecord } from '../state/index.ts';
import { deriveWorkflow, repairsUsed, resolveTaskReference } from '../tasks/index.ts';
import { ValidationProfileStore } from '../validation/index.ts';
import { buildDecisionRequest, parseDecisionResponse } from './decider.ts';
import { DEFAULT_DECISION_LIMITS, buildDecisionPacket } from './packet.ts';
import type { DecisionPacket } from './packet.ts';
import { applyDecisionRules } from './rules.ts';
import { applyAiDecision, decidableReview } from './transitions.ts';

export interface DecideTaskOptions {
  readonly project: LoadedProject;
  readonly runner: ProcessExecutor;
  readonly provider: AiProvider;
  readonly task: string;
  readonly timeoutMs: number;
  /** The run policy's repair budget per task: a rejection with no budget left escalates. */
  readonly maxRepairs: number;
  readonly signal?: AbortSignal;
  readonly store?: StateStore;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly limits?: ReviewPacketLimits;
}

export interface DecideTaskResult {
  /** As stored: `effect` is what Forge did. */
  readonly decision: AiDecisionRecord;
  readonly packet: DecisionPacket;
}

/**
 * Asks the AI decision-maker ONCE to judge the latest undecided review of a
 * task's validated attempt, then applies Forge's rules and records the
 * outcome — including unavailable or invalid answers, which can only
 * escalate. Read-only for the project (verified around the call); the
 * provider never sees Forge state beyond the bounded packet.
 */
export async function decideTask(options: DecideTaskOptions): Promise<DecideTaskResult> {
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? openStateStore(options.project);
  const state = await store.load();
  assertNotPaused(state, 'ask the AI decision-maker');
  const taskId = resolveTaskReference(state, options.task);
  const review = decidableReview(state, taskId);
  const task = state.tasks.find((candidate) => candidate.id === taskId)!;
  const attempt = task.attempts.at(-1)!;

  const git = await GitClient.create({ runner: options.runner, root: options.project.layout.root });
  const profile = await new ValidationProfileStore(options.project.layout).load();
  const packet = await buildDecisionPacket({
    git,
    state,
    task,
    taskKey: deriveWorkflow(state).task(taskId)?.key ?? taskId.slice(0, 8),
    attempt,
    review,
    profile,
    maxRepairs: options.maxRepairs,
    // An evidence-expansion re-review is decided on equally expanded evidence.
    limits: options.limits ?? expandedLimits(DEFAULT_DECISION_LIMITS, review.evidenceRound),
  });

  const requestId = (options.generateId ?? randomUUID)();
  const response = await runReadOnly(options.project, options.runner, () =>
    options.provider.complete(
      buildDecisionRequest({ requestId, packet: packet.text, timeoutMs: options.timeoutMs }),
      options.signal === undefined ? {} : { signal: options.signal },
    ),
  );
  const parsed = parseDecisionResponse(response, {
    findingsToAssess: packet.findingsToAssess,
    findingCount: review.findings.length,
    requirementLabels: packet.requirements.map((requirement) => requirement.label),
  });

  const base = {
    id: requestId,
    taskId,
    attempt: attempt.number,
    reviewId: review.id,
    call: response.call,
    context: packet.summary,
    createdAt: clock().toISOString(),
  };
  let record: AiDecisionRecord;
  if (parsed.ok) {
    const rules = applyDecisionRules(parsed.decision, {
      findings: review.findings,
      validation: attempt.validation,
      requirementLabels: packet.requirements.map((requirement) => requirement.label),
      changesSinceRemediation: packet.changesSinceRemediation,
      repairBlocked: repairBlocked(task, options.maxRepairs),
    });
    record = {
      ...base,
      status: 'decided',
      verdict: parsed.decision.verdict,
      confidence: parsed.decision.confidence,
      reason: parsed.decision.reason,
      requiredActions: parsed.decision.requiredActions,
      humanReason: parsed.decision.humanReason,
      findingAssessments: parsed.decision.findingAssessments,
      requirementAssessments: parsed.decision.requirementAssessments,
      effect: rules.effect,
      policyNote: rules.policyNote,
      diagnostic: null,
    };
  } else {
    // Fail closed: no usable answer is ever acceptance.
    const status: AiDecisionStatus = response.outcome === 'success' ? 'invalid-output' : response.outcome;
    record = {
      ...base,
      status,
      verdict: null,
      confidence: null,
      reason: null,
      requiredActions: [],
      humanReason: null,
      findingAssessments: [],
      requirementAssessments: [],
      effect: 'escalated',
      policyNote: null,
      diagnostic: redactSecrets(parsed.diagnostic, secretValues(process.env)).slice(0, AI_LIMITS.diagnostic),
    };
  }

  let stored = record;
  await store.update((current) => {
    const applied = applyAiDecision(current, record, clock());
    stored = applied.record;
    return applied.state;
  });
  return { decision: stored, packet };
}

/** Why a rejection could not lead to a repair, or null. */
function repairBlocked(task: TaskRecord, maxRepairs: number): string | null {
  const used = repairsUsed(task);
  if (used >= maxRepairs) {
    return `the repair budget is used up (${used}/${maxRepairs})`;
  }
  if (implementationAttempts(task) >= task.maxAttempts) {
    return `all ${task.maxAttempts} attempts have been used`;
  }
  return null;
}
