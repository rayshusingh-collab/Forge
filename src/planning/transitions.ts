import { WorkflowError } from '../core/errors.ts';
import { AI_LIMITS, TASK_LIMITS } from '../state/index.ts';
import type { AiCallMetadata, ContextSummary, PlanDocument, PlanMapping, PlanProposal, ProjectState } from '../state/index.ts';
import { addMilestone, addTask } from '../tasks/index.ts';

/**
 * Pure state transitions for plan proposals. Applying a plan uses the same
 * milestone/task transitions as manual creation, inside one state update:
 * either the whole plan becomes work, or nothing does.
 */

export function recordProposal(
  state: ProjectState,
  input: { readonly id: string; readonly goal: string; readonly plan: PlanDocument; readonly call: AiCallMetadata; readonly context: ContextSummary },
  now: Date,
): ProjectState {
  const proposal: PlanProposal = {
    id: input.id,
    goal: input.goal,
    status: 'proposed',
    plan: input.plan,
    call: input.call,
    context: input.context,
    createdAt: now.toISOString(),
    decidedAt: null,
    reason: null,
    appliedMilestones: [],
    appliedTasks: [],
  };
  let proposals = [...state.planProposals, proposal];
  // Keep the record bounded: drop the oldest rejected, then oldest proposed, never applied ones.
  while (proposals.length > AI_LIMITS.proposals) {
    const drop = proposals.findIndex((candidate) => candidate.status === 'rejected');
    const index = drop !== -1 ? drop : proposals.findIndex((candidate) => candidate.status === 'proposed' && candidate.id !== proposal.id);
    if (index === -1) {
      throw new WorkflowError(`Too many plan proposals are stored (${AI_LIMITS.proposals})`);
    }
    proposals = proposals.filter((_, position) => position !== index);
  }
  return { ...state, planProposals: proposals };
}

/**
 * proposed -> applied: creates the plan's milestones and tasks (in listed
 * order, with dependencies mapped to the new IDs). Starts nothing.
 */
export function applyPlan(state: ProjectState, proposalId: string, generateId: () => string, now: Date): ProjectState {
  const proposal = findProposal(state, proposalId);
  if (proposal.status !== 'proposed') {
    throw new WorkflowError(`Plan ${shortPlanId(proposal.id)} is ${proposal.status}; only a proposed plan can be applied`);
  }
  let next = state;
  const milestones: PlanMapping[] = [];
  const tasks: PlanMapping[] = [];
  const milestoneIds = new Map<string, string>();
  const taskIds = new Map<string, string>();

  for (const milestone of proposal.plan.milestones) {
    const id = generateId();
    next = addMilestone(next, { id, title: milestone.title, description: milestone.description }, now);
    milestoneIds.set(milestone.id, id);
    milestones.push({ proposalId: milestone.id, forgeId: id });
  }
  for (const task of proposal.plan.tasks) {
    const id = generateId();
    next = addTask(
      next,
      {
        id,
        milestoneId: milestoneIds.get(task.milestone)!,
        title: task.title,
        instruction: task.instruction,
        context: task.context,
        dependsOn: task.dependsOn.map((dependency) => taskIds.get(dependency)!),
        maxAttempts: TASK_LIMITS.defaultMaxAttempts,
      },
      now,
    );
    taskIds.set(task.id, id);
    tasks.push({ proposalId: task.id, forgeId: id });
  }

  const applied: PlanProposal = {
    ...proposal,
    status: 'applied',
    decidedAt: now.toISOString(),
    appliedMilestones: milestones,
    appliedTasks: tasks,
  };
  return replaceProposal(next, applied);
}

/** proposed -> rejected, with a recorded human reason. Rejected plans cannot be applied. */
export function rejectPlan(state: ProjectState, proposalId: string, reason: string, now: Date): ProjectState {
  const proposal = findProposal(state, proposalId);
  if (proposal.status !== 'proposed') {
    throw new WorkflowError(`Plan ${shortPlanId(proposal.id)} is ${proposal.status}; only a proposed plan can be rejected`);
  }
  const text = reason.trim();
  if (text === '' || text.length > AI_LIMITS.reason) {
    throw new WorkflowError(`A rejection reason of 1-${AI_LIMITS.reason} characters is required`);
  }
  return replaceProposal(state, { ...proposal, status: 'rejected', decidedAt: now.toISOString(), reason: text });
}

export function resolvePlanReference(state: ProjectState, reference: string): string {
  const ref = reference.trim().toLowerCase();
  if (ref.length < 4) {
    throw new WorkflowError(`"${reference}" is too short to identify a plan; use at least 4 characters of its ID`);
  }
  const matches = state.planProposals.filter((proposal) => proposal.id.toLowerCase().startsWith(ref)).map((proposal) => proposal.id);
  if (matches.length === 0) {
    throw new WorkflowError(`No plan matches "${reference}"`);
  }
  if (matches.length > 1) {
    throw new WorkflowError(`"${reference}" is ambiguous; it matches plans ${matches.map(shortPlanId).join(', ')}`);
  }
  return matches[0]!;
}

export function shortPlanId(id: string): string {
  return id.slice(0, 8);
}

function findProposal(state: ProjectState, proposalId: string): PlanProposal {
  const proposal = state.planProposals.find((candidate) => candidate.id === proposalId);
  if (proposal === undefined) {
    throw new WorkflowError(`Unknown plan "${proposalId}"`);
  }
  return proposal;
}

function replaceProposal(state: ProjectState, proposal: PlanProposal): ProjectState {
  return { ...state, planProposals: state.planProposals.map((candidate) => (candidate.id === proposal.id ? proposal : candidate)) };
}
