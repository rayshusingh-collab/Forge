import { ObjectReader, SchemaViolation } from '../core/validation.ts';
import { findCycle } from './graph.ts';
import { AI_LIMITS } from './model.ts';
import type { PlanDocument, PlanMilestone, PlanTask } from './model.ts';

/**
 * Strict schema for plan documents. Used both to validate a planner's
 * (untrusted) output and to re-validate stored proposals on every load.
 *
 * Rules beyond structure:
 * - at least one milestone and one task; every milestone has a task;
 * - proposal-local IDs are unique and simple (`m1`, `setup-db`);
 * - a task may only depend on tasks listed EARLIER, so the listed order is a
 *   valid execution order (and cycles are impossible — checked anyway);
 * - unknown fields are rejected, so nothing like a `command` or `shell`
 *   field can ride along; `suggestedValidation` is informational text only.
 */

const LOCAL_ID = { pattern: /^[a-z][a-z0-9-]{0,31}$/, patternDescription: 'a short id (lowercase letters, digits, "-")' } as const;

export function decodePlanDocument(raw: unknown, path = ''): PlanDocument {
  const r = new ObjectReader(raw, path, ['summary', 'assumptions', 'milestones', 'tasks', 'risks', 'notes']);
  const plan: PlanDocument = {
    summary: r.string('summary', { maxLength: AI_LIMITS.planDescription }),
    assumptions: r.array('assumptions', listItem, AI_LIMITS.planListItems),
    milestones: r.array('milestones', decodeMilestone, AI_LIMITS.planMilestones),
    tasks: r.array('tasks', decodeTask, AI_LIMITS.planTasks),
    risks: r.array('risks', listItem, AI_LIMITS.planListItems),
    notes: r.nullableString('notes', { maxLength: AI_LIMITS.planDescription }),
  };
  checkPlanStructure(plan, path);
  return plan;
}

function at(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function checkPlanStructure(plan: PlanDocument, path: string): void {
  if (plan.milestones.length === 0) {
    throw new SchemaViolation(at(path, 'milestones'), 'must contain at least one milestone');
  }
  if (plan.tasks.length === 0) {
    throw new SchemaViolation(at(path, 'tasks'), 'must contain at least one task');
  }
  const milestoneIds = new Set<string>();
  plan.milestones.forEach((milestone, index) => {
    if (milestoneIds.has(milestone.id)) {
      throw new SchemaViolation(at(path, `milestones[${index}].id`), `duplicates "${milestone.id}"`);
    }
    milestoneIds.add(milestone.id);
  });

  const seen = new Set<string>();
  plan.tasks.forEach((task, index) => {
    const taskPath = at(path, `tasks[${index}]`);
    if (seen.has(task.id) || milestoneIds.has(task.id)) {
      throw new SchemaViolation(`${taskPath}.id`, `duplicates "${task.id}"`);
    }
    if (!milestoneIds.has(task.milestone)) {
      throw new SchemaViolation(`${taskPath}.milestone`, `references unknown milestone "${task.milestone}"`);
    }
    const deps = new Set<string>();
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new SchemaViolation(`${taskPath}.dependsOn`, 'must not include the task itself');
      }
      if (deps.has(dependency)) {
        throw new SchemaViolation(`${taskPath}.dependsOn`, `lists "${dependency}" more than once`);
      }
      if (!seen.has(dependency)) {
        throw new SchemaViolation(`${taskPath}.dependsOn`, `references "${dependency}", which is not a task listed earlier in the plan`);
      }
      deps.add(dependency);
    }
    seen.add(task.id);
  });

  for (const milestone of plan.milestones) {
    if (!plan.tasks.some((task) => task.milestone === milestone.id)) {
      throw new SchemaViolation(at(path, 'milestones'), `milestone "${milestone.id}" has no tasks`);
    }
  }
  const cycle = findCycle(plan.tasks.map((task) => ({ id: task.id, dependsOn: task.dependsOn })));
  if (cycle !== null) {
    throw new SchemaViolation(at(path, 'tasks'), `contain a dependency cycle: ${cycle.join(' -> ')}`);
  }
}

function decodeMilestone(value: unknown, path: string): PlanMilestone {
  const r = new ObjectReader(value, path, ['id', 'title', 'description']);
  return {
    id: r.string('id', LOCAL_ID),
    title: r.string('title', { maxLength: AI_LIMITS.planTitle }),
    description: r.nullableString('description', { maxLength: AI_LIMITS.planDescription }),
  };
}

function decodeTask(value: unknown, path: string): PlanTask {
  const r = new ObjectReader(value, path, ['id', 'milestone', 'title', 'instruction', 'context', 'dependsOn', 'suggestedValidation']);
  return {
    id: r.string('id', LOCAL_ID),
    milestone: r.string('milestone', LOCAL_ID),
    title: r.string('title', { maxLength: AI_LIMITS.planTitle }),
    instruction: r.string('instruction', { maxLength: AI_LIMITS.planInstruction }),
    context: r.nullableString('context', { maxLength: AI_LIMITS.planContext }),
    dependsOn: r.array('dependsOn', (item, itemPath) => {
      if (typeof item !== 'string' || !LOCAL_ID.pattern.test(item)) {
        throw new SchemaViolation(itemPath, 'must be a task id');
      }
      return item;
    }, AI_LIMITS.planDependencies),
    suggestedValidation: r.array('suggestedValidation', listItem, AI_LIMITS.planSuggestedValidation),
  };
}

function listItem(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > AI_LIMITS.planItemText) {
    throw new SchemaViolation(path, `must be non-empty text of at most ${AI_LIMITS.planItemText} characters`);
  }
  return value;
}
