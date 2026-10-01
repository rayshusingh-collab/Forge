import type { AiProvider } from '../ai/index.ts';
import { ALWAYS_STOP_CONDITIONS, describePolicy, describeStop } from '../orchestration/index.ts';
import type { RunPreview, RunResult, StepResult } from '../orchestration/index.ts';
import type { OrchestrationPolicy, OrchestrationRun, OrchestrationStop } from '../state/index.ts';
import type { Worker } from '../workers/index.ts';

/**
 * Terminal output for `forge run`. Concise and structured: actions, Forge's
 * verdicts, and stop reasons — never prompts, diffs, or provider output.
 */

export function formatPolicyHeader(projectName: string, mode: 'run' | 'step', policy: OrchestrationPolicy, worker: Worker, reviewer: AiProvider | null): string {
  return [
    mode === 'step' ? 'FORGE RUN STEP (at most one workflow step)' : 'FORGE RUN (bounded autonomous orchestration)',
    `Project:       ${projectName}`,
    `Roles:         implementer ${worker.id}; reviewer ${reviewer === null ? 'none' : reviewer.id}; validation = deterministic checks run by Forge`,
    ...describePolicy(policy),
    'Always stops for: ' + ALWAYS_STOP_CONDITIONS.join('; '),
    '',
    '',
  ].join('\n');
}

export function formatStep(step: StepResult): string {
  const lines: string[] = [];
  switch (step.action) {
    case 'execute':
    case 'repair': {
      const repair = step.repair === null ? '' : ` — Repair: ${step.repair.number}/${step.repair.max} (${step.repair.trigger})`;
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}${repair}`);
      if (step.worker !== null) {
        lines.push(`  Worker: ${step.worker.id} — ${step.worker.outcome} (a claim, not evidence)`);
      }
      lines.push(`  Validation: ${step.validation === null ? 'not run' : step.validation === 'passed' ? 'PASSED' : step.validation.toUpperCase()}`);
      lines.push(`  Forge decision: ${decision(step.outcome)}${step.detail === null ? '' : ` — ${step.detail}`}`);
      break;
    }
    case 'review':
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}`, `  Review: ${(step.review ?? step.outcome).toUpperCase()} (advisory)${step.detail === null ? '' : ` — ${step.detail}`}`);
      break;
    case 'commit':
      lines.push(
        `TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}`,
        step.commit === null ? `  Commit: ${step.outcome.toUpperCase()} — ${step.detail ?? ''}` : `  Commit: ${step.detail ?? step.commit} (local; not pushed)`,
      );
      break;
    case 'complete-milestone':
      lines.push(`MILESTONE: ${step.outcome.toUpperCase()}${step.detail === null ? '' : ` — ${step.detail}`}`);
      break;
    case 'stop':
      break;
  }
  if (step.stop !== null && step.outcome === 'refused') {
    lines.push(`  Refused: ${step.detail ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatRunResult(result: RunResult): string {
  const info = describeStop(result.stop.reason);
  const outcome =
    info.category === 'complete' ? 'COMPLETE' : info.category === 'limit' ? 'STOPPED (limit)' : info.category === 'cancelled' ? 'CANCELLED' : 'STOPPED';
  return [
    '',
    `STOP: ${info.label}${result.stop.detail === null ? '' : ` — ${result.stop.detail}`}`,
    '',
    'FORGE RUN RESULT',
    `Outcome:               ${outcome}`,
    `Run:                   ${result.runId.slice(0, 8)}`,
    `Steps:                 ${result.counters.steps}`,
    `Tasks processed:       ${result.counters.tasks}`,
    `Repairs:               ${result.counters.repairs}`,
    `Reviews:               ${result.counters.reviews}`,
    `Commits:               ${result.counters.commits}`,
    `Milestones completed:  ${result.counters.milestones}`,
    `Stop reason:           ${info.label} (${result.stop.reason})`,
    `Next runnable task:    ${result.nextRunnable ?? 'none'}`,
    `Human action required: ${info.category === 'complete' && result.stop.reason === 'complete' ? 'none' : withTask(info.action, result.stopTaskKey) ?? 'none'}`,
    ...(result.recorded ? [] : ['WARNING: the run\'s final state could not be recorded in .forge/state.json.']),
    'Nothing was pushed.',
    '',
  ].join('\n');
}

export function formatPreview(projectName: string, policy: OrchestrationPolicy, preview: RunPreview): string {
  const lines = [
    'FORGE RUN — DRY RUN (nothing is executed, reviewed, committed, or changed)',
    `Project:       ${projectName}`,
    ...describePolicy(policy),
    '',
    `Next runnable task: ${preview.firstRunnable === null ? 'none' : `${preview.firstRunnable.key} ${preview.firstRunnable.task.title}`}`,
    `Next action:   ${describeNext(preview)}`,
  ];
  if (preview.expected.length > 0) {
    lines.push('Expected:', ...preview.expected.map((step) => `  - ${step}`));
  }
  lines.push(
    `AI review would be required: ${policy.review.enabled ? 'yes' : 'no'}`,
    `Auto-commit:   ${policy.autoCommit ? 'enabled' : 'disabled'}`,
    ...(preview.unsafeGit === null ? [] : [`Would stop:    UNSAFE GIT STATE — ${preview.unsafeGit}`]),
    ...(preview.lease.held ? [`Would stop:    another orchestration run holds the lease (${leaseText(preview)})`] : []),
    ...blockerLines(preview),
    'Forge would also stop for: ' + ALWAYS_STOP_CONDITIONS.join('; '),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function formatRunStatus(projectName: string, defaults: OrchestrationPolicy, preview: RunPreview): string {
  const run = preview.lastRun;
  const lines = [
    'FORGE RUN STATUS',
    `Project:          ${projectName}`,
    `Active run:       ${preview.lease.held ? `yes (${leaseText(preview)})` : 'no'}`,
    `Last run:         ${run === null ? 'none' : describeRun(run)}`,
  ];
  if (run !== null) {
    lines.push(
      `Last stop reason: ${run.stop === null ? `none recorded (${run.status})` : formatStop(run.stop)}`,
      `Tasks processed:  ${run.counters.tasks}`,
      `Repairs:          ${run.counters.repairs}`,
      `Reviews:          ${run.counters.reviews}`,
      `Commits:          ${run.counters.commits}`,
      `Recent events:`,
      ...run.events.slice(-10).map((event) => `  #${event.step} ${event.action}${event.attempt === null ? '' : ` (attempt ${event.attempt})`}: ${event.outcome}${event.detail === null ? '' : ` — ${event.detail}`}`),
      ...(run.eventsDropped > 0 ? [`  (${run.eventsDropped} older event(s) were dropped)`] : []),
    );
  }
  lines.push(
    `Next runnable task: ${preview.firstRunnable === null ? 'none' : `${preview.firstRunnable.key} ${preview.firstRunnable.task.title}`}`,
    `Next action (default policy): ${describeNext(preview)}`,
    ...blockerLines(preview),
    'Default policy (override with `forge run` options):',
    ...describePolicy(defaults).map((line) => `  ${line}`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

/** Fills the `<task>` placeholder of a suggested command with the task the stop is about. */
function withTask(action: string | null, key: string | null): string | null {
  return action === null || key === null ? action : action.split('<task>').join(key);
}

function describeNext(preview: RunPreview): string {
  const next = preview.next;
  const task = preview.nextTask === null ? '' : ` ${preview.nextTask.key} ${preview.nextTask.task.title}`;
  switch (next.kind) {
    case 'stop': {
      const info = describeStop(next.reason);
      const action = withTask(info.action, preview.nextTask?.key ?? null);
      return `STOP: ${info.label} — ${next.detail}${action === null ? '' : ` (${action})`}`;
    }
    case 'repair':
      return `repair task${task} (${next.trigger})`;
    case 'complete-milestone':
      return 'complete a milestone';
    default:
      return `${next.kind} task${task}`;
  }
}

function blockerLines(preview: RunPreview): string[] {
  return preview.blockers.length === 0 ? ['Blockers:      none'] : ['Blockers:', ...preview.blockers.map((blocker) => `  - ${blocker}`)];
}

function leaseText(preview: RunPreview): string {
  const owner = preview.lease.owner;
  if (owner === null) {
    return 'owner unknown';
  }
  const alive = preview.lease.ownerAlive === false ? '; that process no longer exists — the lock may be stale' : '';
  return `run ${owner.runId.slice(0, 8)}, pid ${owner.pid} on ${owner.host}, since ${owner.acquiredAt}${alive}`;
}

function describeRun(run: OrchestrationRun): string {
  return `${run.id.slice(0, 8)} (${run.mode}, ${run.status}, started ${run.startedAt}${run.finishedAt === null ? '' : `, ended ${run.finishedAt}`}, ${run.counters.steps} step(s))`;
}

function formatStop(stop: OrchestrationStop): string {
  return `${describeStop(stop.reason).label}${stop.detail === null ? '' : ` — ${stop.detail}`}`;
}

function decision(outcome: string): string {
  switch (outcome) {
    case 'validated':
      return 'SUCCEEDED (deterministic validation passed)';
    case 'validation-failed':
      return 'FAILED (deterministic validation failed)';
    case 'awaiting-validation':
      return 'AWAITING VALIDATION';
    default:
      return outcome.toUpperCase();
  }
}
