import { WorkflowError } from '../core/errors.ts';
import type { ProjectState } from '../state/index.ts';

/**
 * Resolves user-typed references to stable IDs. Persisted state always uses
 * full IDs; these forms exist only for the command line:
 * - a full ID;
 * - a unique ID prefix of at least 4 characters (e.g. `3f2c9a1b`);
 * - an ordinal: `2` for the second milestone, `2.3` for its third task
 *   (at most 3 digits per part, so ordinals never look like ID prefixes).
 * Ambiguous or unknown references fail; nothing is ever guessed.
 */

export const MIN_PREFIX_LENGTH = 4;
export const SHORT_ID_LENGTH = 8;

const MILESTONE_ORDINAL = /^\d{1,3}$/;
const TASK_ORDINAL = /^(\d{1,3})\.(\d{1,3})$/;

export function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH);
}

export function resolveMilestoneReference(state: ProjectState, reference: string): string {
  const ref = reference.trim();
  if (MILESTONE_ORDINAL.test(ref)) {
    const milestone = state.milestones.find((candidate) => candidate.order === Number(ref));
    if (milestone === undefined) {
      throw new WorkflowError(`No milestone number ${ref}`);
    }
    return milestone.id;
  }
  return resolveByPrefix('milestone', ref, state.milestones.map((milestone) => milestone.id));
}

export function resolveTaskReference(state: ProjectState, reference: string): string {
  const ref = reference.trim();
  const ordinal = TASK_ORDINAL.exec(ref);
  if (ordinal !== null) {
    const milestone = state.milestones.find((candidate) => candidate.order === Number(ordinal[1]));
    const task = state.tasks.find((candidate) => candidate.milestoneId === milestone?.id && candidate.order === Number(ordinal[2]));
    if (task === undefined) {
      throw new WorkflowError(`No task ${ref}`);
    }
    return task.id;
  }
  return resolveByPrefix('task', ref, state.tasks.map((task) => task.id));
}

function resolveByPrefix(kind: string, reference: string, ids: readonly string[]): string {
  if (ids.includes(reference)) {
    return reference;
  }
  if (reference.length < MIN_PREFIX_LENGTH) {
    throw new WorkflowError(`"${reference}" is too short to identify a ${kind}; use at least ${MIN_PREFIX_LENGTH} characters of its ID`);
  }
  const lower = reference.toLowerCase();
  const matches = ids.filter((id) => id.toLowerCase().startsWith(lower)).sort();
  if (matches.length === 0) {
    throw new WorkflowError(`No ${kind} matches "${reference}"`);
  }
  if (matches.length > 1) {
    throw new WorkflowError(`"${reference}" is ambiguous; it matches ${kind}s ${matches.map(shortId).join(', ')}. Use more characters.`);
  }
  return matches[0]!;
}
