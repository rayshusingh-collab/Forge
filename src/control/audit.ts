import type { ProjectState } from '../state/index.ts';
import type { WorkflowView } from '../tasks/index.ts';

/**
 * `forge audit`: a chronological, human-readable history DERIVED from the
 * authoritative records (plans, attempts, validation, reviews, commits,
 * approvals, orchestration runs, human control events). There is no second
 * event log that could disagree with them. Payloads are never copied: each
 * line carries IDs, statuses, and a short bounded detail.
 */

export interface AuditEvent {
  readonly at: string;
  readonly kind: string;
  /** What it is about: a task key, plan, approval or run ID (short form). */
  readonly subject: string;
  readonly detail: string;
}

export const AUDIT_DETAIL_LIMIT = 160;

export function deriveAudit(state: ProjectState, view: WorkflowView): AuditEvent[] {
  const events: AuditEvent[] = [];
  const add = (at: string | null, kind: string, subject: string, detail: string): void => {
    if (at !== null) {
      events.push({ at, kind, subject, detail: bound(detail) });
    }
  };
  const key = (taskId: string | null): string => (taskId === null ? '-' : (view.task(taskId)?.key ?? taskId.slice(0, 8)));

  for (const plan of state.planProposals) {
    add(plan.createdAt, 'plan proposed', `plan ${plan.id.slice(0, 8)}`, `by ${plan.call.provider}: ${plan.plan.milestones.length} milestone(s), ${plan.plan.tasks.length} task(s) — ${plan.goal}`);
    if (plan.status !== 'proposed') {
      add(plan.decidedAt, `plan ${plan.status}`, `plan ${plan.id.slice(0, 8)}`, plan.reason ?? 'by a human');
    }
  }
  const runs = new Map(state.workerRuns.map((run) => [run.id, run]));
  for (const task of state.tasks) {
    for (const attempt of task.attempts) {
      const origin =
        attempt.origin === null
          ? 'manual'
          : attempt.origin.repair === null
            ? `run ${attempt.origin.runId.slice(0, 8)}`
            : `run ${attempt.origin.runId.slice(0, 8)}, repair ${attempt.origin.repair.number} (${attempt.origin.repair.trigger})`;
      const worker = runs.get(attempt.runId)?.worker ?? 'unknown worker';
      add(attempt.startedAt, 'attempt started', `${key(task.id)} #${attempt.number}`, `${origin}; worker ${worker}`);
      add(
        attempt.finishedAt,
        'attempt finished',
        `${key(task.id)} #${attempt.number}`,
        `${attempt.outcome}${attempt.validation === null ? '' : `; validation ${attempt.validation.status}`}${attempt.note === null ? '' : ` — ${attempt.note}`}`,
      );
      if (attempt.commit !== null) {
        add(attempt.commit.committedAt, 'commit', `${key(task.id)} #${attempt.number}`, `${attempt.commit.sha.slice(0, 12)} (${attempt.commit.paths} file(s), local)`);
      }
    }
  }
  for (const task of state.tasks) {
    const repair = task.humanRepair;
    if (repair !== null) {
      const subject = `${key(task.id)} (human repair)`;
      add(repair.acceptedAt, 'human repair accepted', subject, `by a human after attempt ${repair.afterAttempt}; validation ${repair.validation.status}; ${repair.changes.files.length} file(s)${repair.acknowledgedViolation ? '; violation acknowledged' : ''} — ${repair.reason}`);
      if (repair.commit !== null) {
        add(repair.commit.committedAt, 'commit', subject, `${repair.commit.sha.slice(0, 12)} (${repair.commit.paths} file(s), local)`);
      }
    }
  }
  for (const milestone of state.milestones) {
    if (milestone.status === 'completed' || milestone.status === 'cancelled') {
      add(milestone.updatedAt, `milestone ${milestone.status}`, `milestone ${milestone.order}`, milestone.title);
    }
  }
  for (const review of state.taskReviews) {
    add(review.createdAt, 'review', `${key(review.taskId)} #${review.attempt}`, `${review.status} by ${review.call.provider} (review ${review.id.slice(0, 8)}, ${review.findings.length} finding(s); advisory)`);
    if (review.decision !== null) {
      const via = review.decision.approvalId === null ? '' : ` through approval ${review.decision.approvalId.slice(0, 8)}`;
      add(review.decision.decidedAt, 'review decision', `${key(review.taskId)} #${review.attempt}`, `${review.decision.kind} by ${review.decision.by}${via}: ${review.decision.reason}`);
    }
  }
  for (const decision of state.aiDecisions) {
    const subject = `${key(decision.taskId)} #${decision.attempt}`;
    const answer =
      decision.status === 'decided'
        ? `${decision.verdict} (confidence ${decision.confidence}) -> ${decision.effect}`
        : `no usable answer (${decision.status}) -> ${decision.effect}`;
    const why = decision.policyNote ?? decision.humanReason ?? decision.reason ?? decision.diagnostic ?? '';
    add(decision.createdAt, `AI decision: ${decision.effect.toUpperCase()}`, subject, `by ${decision.call.provider}${decision.call.model === null ? '' : ` (${decision.call.model})`}: ${answer}; review ${decision.reviewId.slice(0, 8)}, decision ${decision.id.slice(0, 8)}${why === '' ? '' : ` — ${why}`}`);
  }
  for (const remediation of state.remediations) {
    const subject = `${key(remediation.taskId)} #${remediation.fromAttempt}`;
    add(remediation.createdAt, 'remediation required', subject, `by ${remediation.source}: ${remediation.requirements.join('; ')}`);
    add(remediation.resolvedAt, 'remediation satisfied', subject, `accepted with review ${remediation.resolvedByReviewId?.slice(0, 8) ?? '?'}`);
  }
  for (const approval of state.approvals) {
    const subject = `approval ${approval.id.slice(0, 8)}`;
    add(approval.createdAt, 'approval requested', subject, `${approval.type}${approval.taskId === null ? '' : ` for ${key(approval.taskId)}`}: ${approval.reason}`);
    if (approval.resolution !== null) {
      add(approval.resolution.at, `approval ${approval.resolution.decision}`, subject, `by a human: ${approval.resolution.reason}`);
    }
    add(approval.consumedAt, 'approval used', subject, `by run ${approval.consumedByRunId?.slice(0, 8) ?? '?'}`);
    add(approval.invalidatedAt, 'approval invalidated', subject, approval.invalidationReason ?? '');
  }
  for (const run of state.orchestrationRuns) {
    const subject = `run ${run.id.slice(0, 8)}`;
    add(run.startedAt, 'run started', subject, `${run.mode}; policy ${run.policyHash.slice(0, 12)} (${run.policy.access}, review ${run.policy.review.enabled ? 'on' : 'off'}, auto-commit ${run.policy.autoCommit ? 'on' : 'off'})`);
    if (run.status !== 'running') {
      add(
        run.finishedAt,
        run.status === 'interrupted' ? 'run interrupted' : 'run stopped',
        subject,
        run.stop === null ? 'no stop recorded' : `${run.stop.reason}${run.stop.detail === null ? '' : ` — ${run.stop.detail}`}`,
      );
    }
  }
  for (const event of state.controlEvents) {
    add(event.at, event.kind, 'human', `${event.detail ?? ''}${event.reason === null ? '' : `${event.detail === null ? '' : '; '}reason: ${event.reason}`}`);
  }
  // Stable chronological order (ties keep record order).
  return events.map((event, index) => ({ event, index })).sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : a.index - b.index)).map(({ event }) => event);
}

function bound(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= AUDIT_DETAIL_LIMIT ? single : `${single.slice(0, AUDIT_DETAIL_LIMIT - 1)}…`;
}
