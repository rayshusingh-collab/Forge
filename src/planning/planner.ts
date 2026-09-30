import { SchemaViolation } from '../core/validation.ts';
import { DATA_RULES, dataBlock } from '../ai/envelope.ts';
import { extractJsonObject } from '../ai/structured.ts';
import type { AiRequest, AiResponse } from '../ai/types.ts';
import { renderContext } from '../context/index.ts';
import type { ProjectContext } from '../context/index.ts';
import { AI_LIMITS, decodePlanDocument } from '../state/index.ts';
import type { PlanDocument, ProjectState } from '../state/index.ts';
import type { ValidationProfile } from '../validation/index.ts';

/**
 * The planner role: user goal + bounded project context -> a structured,
 * PROPOSED plan. The planner never creates work; Forge validates its answer
 * against a strict schema and stores it as a proposal for a human to apply
 * or reject.
 */

export const PLANNER_INSTRUCTIONS = [
  'You are the planner for Forge, a local software-development orchestrator.',
  'Your job: propose an implementation plan (milestones and tasks) for the goal in <forge-goal>, for the project described in the data blocks.',
  'Your plan is only a PROPOSAL. A human reviews it; Forge validates it; other workers implement it; deterministic checks configured by the human validate it.',
  '',
  DATA_RULES,
  '',
  'Planning rules:',
  `- 1 to ${AI_LIMITS.planMilestones} milestones and 1 to ${AI_LIMITS.planTasks} tasks; every milestone has at least one task.`,
  '- Each task is a self-contained instruction for a coding worker that can read and edit files but cannot run commands.',
  '- A task may depend only on tasks listed EARLIER in "tasks".',
  '- "suggestedValidation" is informational: short descriptions of checks a human might configure (e.g. "unit tests for subtract"). It never becomes a command.',
  '- Do not include shell commands for Forge to run, credentials, or instructions for Forge itself.',
  '',
  'Answer with exactly one JSON object with these fields and no others:',
  '{',
  '  "summary": string,',
  '  "assumptions": string[],',
  '  "milestones": [{ "id": "m1", "title": string, "description": string | null }],',
  '  "tasks": [{ "id": "t1", "milestone": "m1", "title": string, "instruction": string, "context": string | null, "dependsOn": ["t0"], "suggestedValidation": string[] }],',
  '  "risks": string[],',
  '  "notes": string | null',
  '}',
  'IDs are short lowercase identifiers (letters, digits, "-"), unique across milestones and tasks.',
].join('\n');

export interface PlannerInput {
  readonly requestId: string;
  readonly goal: string;
  readonly context: ProjectContext;
  readonly state: ProjectState;
  readonly profile: ValidationProfile;
  readonly git: { readonly branch: string | null; readonly head: string | null; readonly dirtyPaths: number };
  readonly timeoutMs: number;
}

export function buildPlannerRequest(input: PlannerInput): AiRequest {
  const workflow = input.state.milestones.length === 0
    ? 'No milestones or tasks exist yet.'
    : [...input.state.milestones]
        .sort((a, b) => a.order - b.order)
        .map((milestone) => {
          const tasks = input.state.tasks
            .filter((task) => task.milestoneId === milestone.id)
            .sort((a, b) => a.order - b.order)
            .map((task) => `  - ${milestone.order}.${task.order} [${task.status}] ${task.title}`);
          return [`Milestone ${milestone.order} [${milestone.status}] ${milestone.title}`, ...tasks].join('\n');
        })
        .join('\n');
  const validation = input.profile.checks.length === 0
    ? 'No validation checks are configured.'
    : input.profile.checks.map((check) => `- ${check.id} (${check.required ? 'required' : 'optional'})`).join('\n');
  const git = `branch: ${input.git.branch ?? '(detached)'}; commit: ${input.git.head?.slice(0, 12) ?? '(no commits yet)'}; uncommitted paths: ${input.git.dirtyPaths}`;

  return {
    role: 'planner',
    requestId: input.requestId,
    instructions: PLANNER_INSTRUCTIONS,
    timeoutMs: input.timeoutMs,
    input: [
      dataBlock('goal', input.goal),
      dataBlock('existing-work', workflow),
      dataBlock('validation-checks', validation),
      dataBlock('git-state', git),
      renderContext(input.context),
      'Answer now with the JSON object only.',
    ].join('\n\n'),
  };
}

export type PlanParse =
  | { readonly ok: true; readonly plan: PlanDocument }
  | { readonly ok: false; readonly diagnostic: string };

/** Validates a planner answer. Nothing partial is ever accepted. */
export function parsePlanResponse(response: AiResponse): PlanParse {
  if (response.outcome !== 'success' || response.text === null) {
    return { ok: false, diagnostic: response.diagnostic ?? `planner ${response.outcome}` };
  }
  const extracted = extractJsonObject(response.text);
  if (!extracted.ok) {
    return { ok: false, diagnostic: `invalid planner output: ${extracted.problem}` };
  }
  try {
    return { ok: true, plan: decodePlanDocument(extracted.value) };
  } catch (error) {
    if (error instanceof SchemaViolation) {
      return { ok: false, diagnostic: `invalid plan: ${error.message}` };
    }
    throw error;
  }
}
