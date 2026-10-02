import type { AiProvider } from '../ai/index.ts';
import { ALWAYS_STOP_CONDITIONS, describePolicy, describeStop } from '../orchestration/index.ts';
import type { PolicyResolution, RunPreview, RunResult, StepResult } from '../orchestration/index.ts';
import type { OrchestrationPolicy, OrchestrationRun, OrchestrationStop } from '../state/index.ts';
import type { Worker } from '../workers/index.ts';

/**
 * Terminal output for `forge run`. Concise and structured: actions, Forge's
 * verdicts, and stop reasons — never prompts, diffs, or provider output.
 */

export function formatPolicyHeader(
  projectName: string,
  mode: 'run' | 'step',
  policy: OrchestrationPolicy,
  worker: Worker,
  reviewer: AiProvider | null,
  sources: PolicyResolution['sources'] = {},
  decisionMaker: AiProvider | null = null,
): string {
  return [
    mode === 'step'
      ? 'FORGE RUN STEP (at most one workflow step)'
      : policy.autonomous
        ? 'FORGE RUN --AUTONOMOUS (hands-off: recoverable events handled within budgets; hard safety stops unchanged)'
        : 'FORGE RUN (bounded autonomous orchestration)',
    `Project:       ${projectName}`,
    `Roles:         implementer ${worker.id}; reviewer ${reviewer === null ? 'none' : reviewer.id}; decision-maker ${decisionMaker === null ? 'none (humans decide reviews)' : decisionMaker.id}; validation = deterministic checks run by Forge`,
    ...describePolicy(policy),
    describeSources(sources),
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
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}${describeRepair(step)}`);
      if (step.worker !== null) {
        lines.push(`  Worker: ${step.worker.id} — ${step.worker.outcome} (a claim, not evidence)`);
        if (step.worker.outcome !== 'success' && step.timeoutMs !== undefined) {
          lines.push(`  Worker ${step.worker.outcome === 'timeout' ? 'timed out' : 'did not complete'}${step.worker.outcome === 'timeout' ? ` after ${Math.round(step.timeoutMs / 1000)}s` : ''}`);
        }
        if (step.partialWork !== undefined && step.partialWork !== null) {
          lines.push(`  Partial work: ${step.partialWork.files} changed file(s) kept in the working tree (attribution is checked before any recovery)`);
        }
      }
      lines.push(`  Validation: ${step.validation === null ? 'not run' : step.validation === 'passed' ? 'PASSED' : step.validation.toUpperCase()}`);
      lines.push(`  Forge decision: ${decision(step.outcome)}${step.detail === null ? '' : ` — ${step.detail}`}`);
      break;
    }
    case 'review':
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}`, `  Review: ${(step.review ?? step.outcome).toUpperCase()} (advisory)${step.detail === null ? '' : ` — ${step.detail}`}`);
      break;
    case 'decide':
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}`, `  AI decision: ${aiDecisionLabel(step.outcome)}${step.detail === null ? '' : ` — ${step.detail}`}`);
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
    case 'apply-approval':
      lines.push(`TASK ${step.taskKey ?? '?'} ${step.taskTitle ?? ''}`, `  ${step.outcome === 'remediation-required' ? 'Human review rejection' : 'Human approval'}: ${step.detail ?? step.outcome}`);
      if (step.worker !== null) {
        lines.push(
          `  Worker: ${step.worker.id} — ${step.worker.outcome} (a claim, not evidence)`,
          `  Validation: ${step.validation === null ? 'not run' : step.validation === 'passed' ? 'PASSED' : step.validation.toUpperCase()}`,
          `  Forge decision: ${decision(step.outcome)}`,
        );
      }
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
    result.stop.reason === 'complete'
      ? 'WORKFLOW COMPLETE'
      : info.category === 'complete'
        ? 'COMPLETE'
        : info.category === 'limit'
          ? 'STOPPED (limit)'
          : info.category === 'cancelled'
            ? 'CANCELLED'
            : 'STOPPED';
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
    `Timeout recoveries:    ${result.counters.timeoutRecoveries}`,
    `Provider retries:      ${result.counters.providerRetries}`,
    `Evidence re-reviews:   ${result.counters.evidenceReviews}`,
    `Reviews:               ${result.counters.reviews}`,
    `AI decisions:          ${result.counters.decisions}`,
    `Commits:               ${result.counters.commits}`,
    `Milestones completed:  ${result.counters.milestones}`,
    `Human interventions:   ${result.counters.humanInterventions}`,
    `Stop reason:           ${info.label} (${result.stop.reason})`,
    `Next runnable task:    ${result.nextRunnable ?? 'none'}`,
    `Human action required: ${info.category === 'complete' && result.stop.reason === 'complete' ? 'none' : withTask(info.action, result.stopTaskKey) ?? 'none'}`,
    ...(result.approvalId === null
      ? []
      : [
          `Approval:              ${result.approvalId.slice(0, 8)} ${result.approvalCreated ? '(requested now)' : '(already requested)'} — inspect: forge approval show ${result.approvalId.slice(0, 8)}`,
          `                       decide: forge approval approve|reject ${result.approvalId.slice(0, 8)} --reason "..."; explanation: forge explain`,
        ]),
    ...(result.recorded ? [] : ['WARNING: the run\'s final state could not be recorded in .forge/state.json.']),
    'Nothing was pushed.',
    '',
  ].join('\n');
}

export function formatPreview(projectName: string, policy: OrchestrationPolicy, preview: RunPreview, sources: PolicyResolution['sources'] = {}): string {
  const lines = [
    'FORGE RUN — DRY RUN (nothing is executed, reviewed, committed, or changed)',
    `Project:       ${projectName}`,
    ...describePolicy(policy),
    describeSources(sources),
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

/** The repair or recovery an attempt step was, with its budget (and the adaptive timeout of a timeout recovery). */
function describeRepair(step: StepResult): string {
  const repair = step.repair;
  if (repair === null) {
    return '';
  }
  switch (repair.trigger) {
    case 'timeout':
      return ` — Recovery: continuing the timed-out attempt (timeout recovery ${repair.number}/${repair.max}${step.timeoutMs === undefined ? '' : `, worker timeout ${Math.round(step.timeoutMs / 1000)}s`})`;
    case 'worker-failure':
      return ` — Recovery: retrying after a worker failure (provider retry ${repair.number}/${repair.max})`;
    default:
      return ` — Repair: ${repair.number}/${repair.max} (${repair.trigger})`;
  }
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
      return next.trigger === 'timeout' || next.trigger === 'worker-failure' ? `recover task${task} (${next.trigger} continuation)` : `repair task${task} (${next.trigger})`;
    case 'review':
      return next.purpose === 'expand' ? `re-review task${task} with expanded evidence (round ${next.evidenceRound})` : `review task${task}`;
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

/** Which settings came from the command line or the project configuration (everything else is a default). */
function describeSources(sources: PolicyResolution['sources']): string {
  const from = (source: string): string[] =>
    Object.entries(sources)
      .filter(([, value]) => value === source)
      .map(([key]) => key);
  const cli = from('cli');
  const project = from('project');
  return `Settings from: command line [${cli.join(', ') || 'none'}]; project config [${project.join(', ') || 'none'}]; everything else default`;
}

/** Step outcome of an AI decision, as shown to the human. */
function aiDecisionLabel(outcome: string): string {
  switch (outcome) {
    case 'ai-accepted':
      return 'ACCEPTED (AI decision; the review is accepted, safe-commit rules still apply)';
    case 'ai-rejected':
      return 'REJECTED — remediation required (the task will be repaired within its budget)';
    case 'ai-escalated':
      return 'ESCALATED — a human decides';
    default:
      return outcome.toUpperCase();
  }
}
