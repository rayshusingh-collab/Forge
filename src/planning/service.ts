import { randomUUID } from 'node:crypto';

import { ValidationError } from '../core/errors.ts';
import { runReadOnly } from '../ai/read-only-guard.ts';
import type { AiProvider } from '../ai/types.ts';
import { DEFAULT_CONTEXT_LIMITS, collectProjectContext, summarizeContext } from '../context/index.ts';
import type { ContextLimits, ProjectContext } from '../context/index.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import { openStateStore } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { AI_LIMITS } from '../state/index.ts';
import type { AiCallMetadata, PlanProposal, StateStore } from '../state/index.ts';
import { ValidationProfileStore } from '../validation/index.ts';
import { buildPlannerRequest, parsePlanResponse } from './planner.ts';
import { recordProposal } from './transitions.ts';

export interface CreatePlanOptions {
  readonly project: LoadedProject;
  readonly runner: ProcessExecutor;
  readonly provider: AiProvider;
  readonly goal: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly store?: StateStore;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly contextLimits?: ContextLimits;
}

export type CreatePlanResult =
  | { readonly ok: true; readonly proposal: PlanProposal; readonly context: ProjectContext }
  | { readonly ok: false; readonly outcome: string; readonly diagnostic: string; readonly call: AiCallMetadata; readonly context: ProjectContext };

/**
 * `forge plan create`: collect bounded context, ask the planner once
 * (read-only, verified), validate the answer, and store it as a PROPOSAL.
 * Creates no milestones or tasks and runs nothing. A failed or invalid
 * answer stores nothing at all.
 */
export async function createPlan(options: CreatePlanOptions): Promise<CreatePlanResult> {
  const goal = options.goal.trim();
  if (goal === '' || goal.length > AI_LIMITS.goal || goal.includes('\0')) {
    throw new ValidationError(`The goal must be 1-${AI_LIMITS.goal} characters`);
  }
  const clock = options.clock ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;
  const store = options.store ?? openStateStore(options.project);

  const state = await store.load();
  const profile = await new ValidationProfileStore(options.project.layout).load();
  const git = await GitClient.create({ runner: options.runner, root: options.project.layout.root });
  const status = await git.status();
  const context = await collectProjectContext(git, options.contextLimits ?? DEFAULT_CONTEXT_LIMITS);

  const requestId = generateId();
  const request = buildPlannerRequest({
    requestId,
    goal,
    context,
    state,
    profile,
    git: { branch: status.branch, head: status.head, dirtyPaths: status.entries.length },
    timeoutMs: options.timeoutMs,
  });
  const response = await runReadOnly(options.project, options.runner, () =>
    options.provider.complete(request, options.signal === undefined ? {} : { signal: options.signal }),
  );

  const parsed = parsePlanResponse(response);
  if (!parsed.ok) {
    const outcome = response.outcome === 'success' ? 'invalid-output' : response.outcome;
    return { ok: false, outcome, diagnostic: parsed.diagnostic.slice(0, AI_LIMITS.diagnostic), call: response.call, context };
  }

  const next = await store.update((current) =>
    recordProposal(current, { id: requestId, goal, plan: parsed.plan, call: response.call, context: summarizeContext(context) }, clock()),
  );
  return { ok: true, proposal: next.planProposals.find((proposal) => proposal.id === requestId)!, context };
}

/** What a planner would receive, without calling it (for `forge plan context`). */
export async function previewPlanningContext(project: LoadedProject, runner: ProcessExecutor, limits: ContextLimits = DEFAULT_CONTEXT_LIMITS): Promise<ProjectContext> {
  const git = await GitClient.create({ runner, root: project.layout.root });
  return collectProjectContext(git, limits);
}
