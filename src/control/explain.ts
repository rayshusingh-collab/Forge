import { decideNext } from '../orchestration/decision.ts';
import { describeStop } from '../orchestration/stop-reason.ts';
import type { ApprovalRecord, OrchestrationPolicy, OrchestrationRun, ProjectState, StopReason } from '../state/index.ts';
import { budgetUsage, describeBudgetUsage, repairsUsed } from '../tasks/index.ts';
import type { TaskView, WorkflowView } from '../tasks/index.ts';

/**
 * `forge explain`: why Forge stopped, in plain language, derived only from
 * stored records (the last orchestration run, the task's attempts,
 * validation, reviews, approvals, and the pause record). Deterministic;
 * no AI is asked to explain anything.
 */

export interface ExplainInput {
  readonly state: ProjectState;
  readonly view: WorkflowView;
  /** Policy used to describe what would happen NOW (the last run's policy, or the current default). */
  readonly policy: OrchestrationPolicy;
}

export function explain(input: ExplainInput): string[] {
  const { state, view } = input;
  const lines: string[] = [];
  if (state.pause !== null) {
    lines.push(
      `The project is PAUSED (since ${state.pause.pausedAt}, by a human): ${state.pause.reason}`,
      'Autonomous runs, worker and AI calls, validation and commits are refused until it is resumed.',
      'Required action: forge resume --reason "..." (when you are ready)',
      '',
    );
  }

  const run = state.orchestrationRuns.at(-1);
  if (run === undefined) {
    lines.push('Forge has not run autonomously in this project yet.');
  } else {
    lines.push(...explainRun(state, view, run));
  }

  const now = decideNext(state, view, input.policy, { runId: 'explain', tasksStarted: new Set(), reviewsThisRun: new Set() });
  lines.push('', 'Now:');
  if (now.kind === 'stop') {
    const info = describeStop(now.reason);
    lines.push(`  A run would stop: ${info.label} — ${now.detail}`);
    const action = withKey(info.action, now.taskId === null ? null : (view.task(now.taskId)?.key ?? null));
    if (action !== null) {
      lines.push(`  Required action: ${action}`);
    }
    if (now.approvalRequest !== undefined) {
      lines.push('  (Running `forge run` would record an approval request for this.)');
    }
  } else if (now.kind === 'apply-approval' && now.resolution === 'rejected') {
    const task = view.task(now.taskId);
    const approval = state.approvals.find((candidate) => candidate.id === now.approvalId);
    lines.push(
      `  A human rejected review acceptance for task ${task?.key ?? now.taskId.slice(0, 8)} (approval ${now.approvalId.slice(0, 8)}).`,
      `  Reason: ${approval?.resolution?.reason ?? ''}`,
      "  A run would record that as the human's remediation decision, reopen the task for remediation, and then repair it (validated and reviewed again).",
    );
  } else {
    const task = 'taskId' in now ? view.task(now.taskId) : undefined;
    lines.push(`  A run would ${describeAction(now.kind)}${task === undefined ? '' : ` task ${task.key} "${task.task.title}"`}.`);
  }
  return lines;
}

function explainRun(state: ProjectState, view: WorkflowView, run: OrchestrationRun): string[] {
  const lines = [`Last run ${run.id.slice(0, 8)} (${run.mode}) started ${run.startedAt}${run.finishedAt === null ? '' : `, ended ${run.finishedAt}`}: ${run.counters.steps} step(s), ${run.counters.tasks} task(s), ${run.counters.repairs} repair(s), ${run.counters.commits} commit(s).`];
  lines.push(...decisionsDuringRun(state, view, run));
  if (run.status === 'running') {
    lines.push('It is still recorded as running (or crashed without recording a stop). `forge run status` shows whether its process is alive.');
    return lines;
  }
  if (run.stop === null) {
    lines.push('It ended without recording a stop reason (it was interrupted).');
    return lines;
  }
  const stop = run.stop;
  const info = describeStop(stop.reason);
  const task = stop.taskId === null ? undefined : view.task(stop.taskId);
  lines.push('', `Forge stopped because ${sentence(stop.reason, task, state)}`, `  (${info.label}${stop.detail === null ? '' : ` — ${stop.detail}`})`);
  if (task !== undefined) {
    const last = task.lastAttempt;
    const review = last === undefined ? undefined : [...state.taskReviews].reverse().find((candidate) => candidate.taskId === task.task.id && candidate.attempt === last.number);
    const repairOn = run.policy.repair.onValidationFailure || run.policy.repair.onBlockingReview;
    lines.push(
      '',
      `Task ${task.key} "${task.task.title}" — now ${task.condition}, attempt ${task.attemptsUsed}/${task.task.maxAttempts}`,
      `Deterministic validation: ${last?.validation === null || last?.validation === undefined ? 'NOT RUN' : last.validation.status === 'passed' ? 'PASS' : last.validation.status.toUpperCase()}`,
      `AI review: ${!run.policy.review.enabled ? 'disabled for that run' : review === undefined ? 'NOT REVIEWED' : review.status.toUpperCase().replace('-', ' ')}${review === undefined ? '' : ` (review ${review.id.slice(0, 8)})`}`,
      `Automatic repair: ${repairOn ? `enabled (${repairsUsed(task.task)}/${run.policy.repair.maxPerTask} used)` : 'disabled'}`,
      `Budgets used: ${describeBudgetUsage(budgetUsage(state, task.task), run.policy).join('; ')}`,
    );
    lines.push(...explainDecision(state, task, run.policy));
  }
  const approval = relatedApproval(state, stop.taskId);
  if (approval !== undefined) {
    lines.push(`Approval: ${approval.id.slice(0, 8)} (${approval.type}) is ${approval.status.toUpperCase()}${approval.resolution === null ? '' : ` — ${approval.resolution.reason}`}`);
  }
  lines.push('', 'Required action:');
  const key = task?.key ?? null;
  if (approval?.status === 'pending') {
    lines.push(`  Inspect: forge approval show ${approval.id.slice(0, 8)}`, `  Then:    forge approval approve ${approval.id.slice(0, 8)} --reason "..."   or   forge approval reject ${approval.id.slice(0, 8)} --reason "..."`);
    if (approval.type === 'review-acceptance' && key !== null) {
      lines.push(`  Or remediate: forge task review-reject ${key} --reason "..."   (or change the policy explicitly, e.g. --repair-review)`);
    }
  } else {
    lines.push(`  ${withKey(info.action, key) ?? 'none'}`);
  }
  return lines;
}

/** What the AI decision-maker decided during the run, so an automatic acceptance or rejection is never silent. */
function decisionsDuringRun(state: ProjectState, view: WorkflowView, run: OrchestrationRun): string[] {
  const end = run.finishedAt ?? '9999';
  const decisions = state.aiDecisions.filter((decision) => decision.createdAt >= run.startedAt && decision.createdAt <= end);
  if (decisions.length === 0) {
    return [];
  }
  const count = (effect: string): number => decisions.filter((decision) => decision.effect === effect).length;
  return [
    `AI decisions during this run: ${decisions.length} (${count('accepted')} accepted, ${count('remediation-required')} remediation, ${count('escalated')} escalated)`,
    ...decisions.slice(-5).map((decision) => {
      const answer = decision.status === 'decided' ? `${decision.verdict}, ${decision.confidence} confidence` : `no usable answer (${decision.status})`;
      const why = decision.policyNote ?? decision.humanReason ?? decision.reason ?? decision.diagnostic ?? '';
      return `  task ${view.task(decision.taskId)?.key ?? decision.taskId.slice(0, 8)} attempt ${decision.attempt}: ${decision.effect.toUpperCase()} — ${answer}${why === '' ? '' : `: ${why}`}`;
    }),
  ];
}

/** The task's latest AI decision and outstanding remediation, when auto-decision or remediation is involved. */
function explainDecision(state: ProjectState, task: TaskView, policy: OrchestrationPolicy): string[] {
  const lines: string[] = [];
  const decision = state.aiDecisions.filter((candidate) => candidate.taskId === task.task.id).at(-1);
  if (decision !== undefined) {
    const answer = decision.status === 'decided' ? `${decision.verdict} with ${decision.confidence} confidence` : `no usable answer (${decision.status})`;
    lines.push(`AI decision: ${decision.effect.toUpperCase()} — the decision-maker (${decision.call.provider}) answered ${answer} on attempt ${decision.attempt}`);
    if (decision.reason !== null) {
      lines.push(`  Its reason: ${decision.reason}`);
    }
    if (decision.policyNote !== null) {
      lines.push(`  Forge's rule: ${decision.policyNote}`);
    }
    if (decision.humanReason !== null) {
      lines.push(`  Needs a human because: ${decision.humanReason}`);
    }
    if (decision.diagnostic !== null) {
      lines.push(`  Problem: ${decision.diagnostic}`);
    }
  } else if (policy.decision.enabled) {
    lines.push('AI decision: none recorded for this task yet');
  }
  const open = state.remediations.filter((remediation) => remediation.taskId === task.task.id && remediation.status === 'open');
  for (const remediation of open) {
    lines.push(`Outstanding remediation (from attempt ${remediation.fromAttempt}, by ${remediation.source}): ${remediation.requirements.join('; ')}`);
  }
  return lines;
}

/** The newest approval tied to the task (or, without a task, the newest open one). */
function relatedApproval(state: ProjectState, taskId: string | null): ApprovalRecord | undefined {
  return [...state.approvals]
    .reverse()
    .find((approval) => (taskId === null ? approval.status === 'pending' : approval.taskId === taskId));
}

function sentence(reason: StopReason, task: TaskView | undefined, state: ProjectState): string {
  const name = task === undefined ? 'a task' : `Task ${task.key}`;
  const review = task?.lastAttempt === undefined ? undefined : [...state.taskReviews].reverse().find((candidate) => candidate.taskId === task.task.id);
  switch (reason) {
    case 'complete':
      return 'the workflow is complete: every milestone and task is finished.';
    case 'review-decision-required':
      return `${name} received ${review?.status === 'blocking-concerns' ? 'a blocking AI review finding' : 'AI review concerns'} that need a human decision.`;
    case 'repair-not-permitted':
      return `${name} failed deterministic validation and automatic repair is not permitted.`;
    case 'repair-budget-exhausted':
      return `${name} kept failing and its repair budget is used up.`;
    case 'worker-failed':
      return `${name}'s worker invocation did not complete (this is not a validation failure).`;
    case 'interrupted-task':
      return `${name} was interrupted and its outcome is unknown.`;
    case 'integrity-acknowledgement-required':
    case 'integrity-violation':
      return `protected Forge state changed during ${name.toLowerCase()}'s execution.`;
    case 'scope-acknowledgement-required':
      return `${name} changed things outside its permitted scope.`;
    case 'decision-escalated':
      return `the AI decision-maker escalated ${name.toLowerCase()}'s review to a human instead of deciding it.`;
    case 'decision-overruled':
      return `Forge's rules did not let the AI decision-maker's verdict on ${name.toLowerCase()}'s review take effect.`;
    case 'decision-maker-unavailable':
      return `the AI decision-maker could not be reached for ${name.toLowerCase()} (never treated as acceptance).`;
    case 'decision-maker-invalid-output':
      return `the AI decision-maker's answer for ${name.toLowerCase()} broke the decision contract and was rejected (never treated as acceptance).`;
    case 'decision-maker-timeout':
      return `the AI decision-maker did not answer in time for ${name.toLowerCase()} (never treated as acceptance).`;
    case 'reviewer-unavailable':
      return `the AI reviewer did not produce a usable review of ${name.toLowerCase()} (never treated as clear).`;
    case 'commit-refused':
      return `the safe-commit rules refused to commit ${name.toLowerCase()}'s changes.`;
    case 'manual-validation-required':
      return `${name} is awaiting manual validation.`;
    case 'paused':
      return 'a human paused the project.';
    case 'approval-rejected':
      return `a human rejected the approval ${name.toLowerCase()} needed.`;
    case 'timeout-recovery-exhausted':
      return `${name}'s worker kept timing out and its timeout-recovery budget is used up (its partial work is still in the working tree).`;
    case 'provider-retry-exhausted':
      return `a provider kept failing for ${name.toLowerCase()} and the provider-retry budget is used up.`;
    case 'unsafe-partial-work':
      return `${name}'s interrupted worker left changes Forge cannot safely attribute to the task, so it will not continue them automatically.`;
    case 'evidence-review-exhausted':
      return `the AI decision-maker was still not confident about ${name.toLowerCase()} after the evidence re-review budget was used.`;
    case 'validation-repair-exhausted':
      return `${name} still fails deterministic validation and its implementation-repair budget is used up.`;
    case 'review-repair-exhausted':
      return `${name}'s review still requires remediation and its implementation-repair budget is used up.`;
    case 'review-rejection-blocked':
      return `a human rejected acceptance of ${name.toLowerCase()}, but Forge cannot reopen it for a repair.`;
    default:
      return `${describeStop(reason).label.toLowerCase()}.`;
  }
}

function describeAction(kind: string): string {
  switch (kind) {
    case 'execute':
      return 'execute';
    case 'repair':
      return 'repair';
    case 'review':
      return 'review';
    case 'decide':
      return 'ask the AI decision-maker to judge the review of';
    case 'commit':
      return 'commit';
    case 'apply-approval':
      return 'use a human approval for';
    default:
      return 'complete a milestone';
  }
}

export function withKey(action: string | null, key: string | null): string | null {
  return action === null || key === null ? action : action.split('<task>').join(key);
}
