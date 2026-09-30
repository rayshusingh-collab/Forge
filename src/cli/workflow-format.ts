import type { ChangeSummary, ProjectState, WorkerRunRecord } from '../state/index.ts';
import { TASK_CONDITIONS, commitEligibility, shortId } from '../tasks/index.ts';
import { formatValidation } from './commands/validation.ts';
import type { MilestoneView, TaskCondition, TaskView, WorkflowView } from '../tasks/index.ts';

/** Deterministic, concise text rendering of workflow views. */

export function formatMilestoneList(view: WorkflowView): string {
  if (view.milestones.length === 0) {
    return 'No milestones. Add one with: forge milestone add --title "<title>"\n';
  }
  const rows = view.milestones.map((milestone) => [
    String(milestone.milestone.order),
    shortId(milestone.milestone.id),
    milestone.milestone.status,
    progress(milestone),
    milestone.milestone.title,
  ]);
  return table(['#', 'ID', 'STATUS', 'DONE', 'TITLE'], rows);
}

export function formatMilestone(milestone: MilestoneView, view: WorkflowView): string {
  const lines = [
    `Milestone ${milestone.milestone.order}: ${milestone.milestone.title}`,
    `  ID:          ${milestone.milestone.id}`,
    `  Status:      ${milestone.milestone.status}`,
    `  Tasks:       ${countConditions(milestone.tasks)}`,
    `  Complete?    ${completionHint(milestone)}`,
  ];
  if (milestone.milestone.description !== null) {
    lines.push(`  Description: ${milestone.milestone.description}`);
  }
  lines.push('');
  lines.push(milestone.tasks.length === 0 ? 'No tasks yet.' : formatTaskTable(milestone.tasks, view).trimEnd());
  return `${lines.join('\n')}\n`;
}

export function formatTaskTable(tasks: readonly TaskView[], view: WorkflowView): string {
  if (tasks.length === 0) {
    return 'No tasks.\n';
  }
  const rows = tasks.map((task) => [
    task.key,
    shortId(task.task.id),
    task.condition,
    `${task.attemptsUsed}/${task.task.maxAttempts}`,
    task.task.title,
    task.task.dependsOn.length === 0 ? '' : `after ${task.task.dependsOn.map((id) => view.task(id)?.key ?? shortId(id)).join(', ')}`,
  ]);
  return table(['KEY', 'ID', 'CONDITION', 'TRIES', 'TITLE', 'DEPENDS ON'], rows);
}

export function formatTask(task: TaskView, view: WorkflowView, state: ProjectState): string {
  const runs = new Map(state.workerRuns.map((run) => [run.id, run]));
  const lines = [
    `Task ${task.key}: ${task.task.title}`,
    `  ID:          ${task.task.id}`,
    `  Milestone:   ${task.milestone.order} ${task.milestone.title} (${task.milestone.status})`,
    `  Status:      ${task.task.status}`,
    `  Condition:   ${task.condition}${conditionHint(task)}`,
    `  Attempts:    ${task.attemptsUsed} of ${task.task.maxAttempts} used`,
  ];
  if (task.task.dependsOn.length > 0) {
    lines.push('  Depends on:');
    for (const id of task.task.dependsOn) {
      const dependency = view.task(id);
      lines.push(`    ${dependency?.key ?? shortId(id)}  ${dependency?.condition ?? 'unknown'}  ${dependency?.task.title ?? id}`);
    }
  }
  if (task.task.cancelReason !== null) {
    lines.push(`  Cancelled:   ${task.task.cancelReason}`);
  }
  lines.push('  Instruction:', indent(excerptBlock(task.task.instruction, 2_000)));
  if (task.task.context !== null) {
    lines.push('  Context:', indent(excerptBlock(task.task.context, 1_000)));
  }
  const last = task.lastAttempt;
  if (last?.changes !== null && last?.changes !== undefined) {
    lines.push(indent(formatChanges(last.changes).trimEnd()));
  }
  if (last?.validation !== null && last?.validation !== undefined) {
    lines.push(`  Validation (${last.validation.status}, ${last.validation.finishedAt}):`, formatValidation(last.validation).trimEnd());
  }
  if (task.task.status === 'succeeded') {
    const eligibility = commitEligibility(last);
    lines.push(
      last?.commit !== null && last?.commit !== undefined
        ? `  Commit:      ${last.commit.sha} (${last.commit.paths} file(s))`
        : eligibility.ok
          ? `  Commit:      not committed; eligible — forge task commit ${task.key}`
          : `  Commit:      not committed; ${eligibility.reason}`,
    );
  }
  const review = state.taskReviews.filter((candidate) => candidate.taskId === task.task.id).at(-1);
  if (review !== undefined) {
    lines.push(
      `  AI review:   ${review.status} (attempt ${review.attempt}, advisory)${review.decision === null ? '' : ` — decided: ${review.decision.kind}`}   (forge task review-show ${task.key})`,
    );
  }
  if (task.task.attempts.length > 0) {
    lines.push('  History:');
    for (const attempt of task.task.attempts) {
      const run = runs.get(attempt.runId);
      lines.push(`    #${attempt.number} ${attempt.outcome}  ${formatRun(run)}  started ${attempt.startedAt}`);
      if (attempt.note !== null) {
        lines.push(`       note: ${attempt.note}`);
      }
      const detail = run?.diagnostic ?? run?.summary;
      if (detail !== null && detail !== undefined) {
        lines.push(`       ${oneLine(detail, 200)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** `Changes:  2 modified, 1 added (…)` plus notes for anything Forge treats cautiously. */
export function formatChanges(changes: ChangeSummary): string {
  const count = (kind: string): number => changes.files.filter((file) => file.change === kind).length;
  const lines = [
    `Changes:  ${count('modified')} modified, ${count('added')} added, ${count('deleted')} deleted` +
      (count('renamed') > 0 ? `, ${count('renamed')} renamed` : '') +
      (changes.preexistingUntouched > 0 ? `  (${changes.preexistingUntouched} pre-existing change(s) left untouched)` : ''),
  ];
  for (const file of changes.files.slice(0, 20)) {
    lines.push(`  ${file.change.padEnd(8)} ${file.path}${file.attribution === 'mixed' ? '  [already had uncommitted changes before the task]' : ''}`);
  }
  if (changes.files.length > 20) {
    lines.push(`  … ${changes.files.length - 20} more`);
  }
  if (changes.outOfScope.length > 0) {
    lines.push(`  OUT OF SCOPE: ${changes.outOfScope.join(', ')}`);
  }
  if (changes.indexChanged.length > 0) {
    lines.push(`  Staged during the task: ${changes.indexChanged.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatReady(view: WorkflowView): string {
  if (view.runnable.length === 0) {
    const waiting = view.tasks.filter((task) => ['waiting', 'awaiting-validation', 'running', 'interrupted'].includes(task.condition));
    return waiting.length === 0
      ? 'No runnable tasks.\n'
      : `No runnable tasks. ${countConditions(waiting)}.\n`;
  }
  return formatTaskTable(view.runnable, view);
}

/** One line per condition that has tasks, in a fixed order. */
export function countConditions(tasks: readonly TaskView[]): string {
  if (tasks.length === 0) {
    return '0';
  }
  const parts = TASK_CONDITIONS.map((condition): [TaskCondition, number] => [condition, tasks.filter((task) => task.condition === condition).length])
    .filter(([, count]) => count > 0)
    .map(([condition, count]) => `${condition} ${count}`);
  return `${tasks.length} (${parts.join(', ')})`;
}

function progress(milestone: MilestoneView): string {
  const relevant = milestone.tasks.filter((task) => task.task.status !== 'cancelled');
  const done = relevant.filter((task) => task.task.status === 'succeeded').length;
  return `${done}/${relevant.length}`;
}

function completionHint(milestone: MilestoneView): string {
  if (milestone.milestone.status === 'completed' || milestone.milestone.status === 'cancelled') {
    return milestone.milestone.status;
  }
  if (milestone.canComplete) {
    return 'yes — run `forge milestone complete ' + milestone.milestone.order + '`';
  }
  return milestone.hasStuckTasks ? 'no — some tasks are blocked or out of attempts' : 'no — tasks remain';
}

function conditionHint(task: TaskView): string {
  switch (task.condition) {
    case 'ready':
    case 'retryable':
      return ` (run: forge task run ${task.key}${task.requiresIntegrityAcknowledgement ? ' --acknowledge-integrity-violation' : ''})`;
    case 'awaiting-validation':
      return ` (forge task accept ${task.key} | forge task reject ${task.key} --reason "...")`;
    case 'interrupted':
      return ` (forge task recover ${task.key})`;
    default:
      return '';
  }
}

function formatRun(run: WorkerRunRecord | undefined): string {
  if (run === undefined) {
    return 'run unknown';
  }
  const duration = run.durationMs === null ? '' : ` ${(run.durationMs / 1000).toFixed(1)}s`;
  return `${run.worker} ${run.access}${duration}`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const render = (row: readonly string[]): string =>
    row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ').trimEnd();
  return `${[render(headers), ...rows.map(render)].join('\n')}\n`;
}

function excerptBlock(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}… (${text.length} characters)`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}
