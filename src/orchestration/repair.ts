import { ORCHESTRATION_LIMITS } from '../state/index.ts';
import type { ProjectState, RepairTrigger, TaskAttempt, TaskRecord, TaskReview } from '../state/index.ts';
import { WORKER_REQUEST_LIMITS } from '../workers/index.ts';

/**
 * Builds the evidence for a repair attempt from Forge's own bounded
 * records: the failed checks (ids, statuses, exit codes, and the stored
 * output excerpts), the files the attempt changed, and — for review repairs —
 * the Forge-recorded findings and the remediation decision.
 *
 * Everything quoted here (check output, finding text, reasons) is DATA. The
 * worker receives it inside a fenced `<forge-repair-evidence>` block; only
 * Forge's fixed envelope rules are instructions. Nothing here is executed,
 * and no command line from a check is included — only its ID.
 */

export interface RepairEvidence {
  /** Full evidence for the worker (bounded). */
  readonly text: string;
  /** Short summary stored with the repair record. */
  readonly summary: string;
}

const MAX_TEXT = WORKER_REQUEST_LIMITS.repairEvidenceCharacters;
const MAX_FILES = 50;

export function buildRepairEvidence(
  state: ProjectState,
  task: TaskRecord,
  trigger: RepairTrigger,
  fromAttempt: number,
  reviewId: string | null,
): RepairEvidence {
  const attempt = task.attempts[fromAttempt - 1];
  if (attempt === undefined) {
    throw new Error(`Task ${task.id} has no attempt ${fromAttempt}`);
  }
  const lines = [
    `Repair of task "${task.title}" after attempt ${fromAttempt}.`,
    trigger === 'validation'
      ? 'Why: Forge ran the project\'s required deterministic checks on the previous attempt and they did not pass.'
      : 'Why: an AI review of the previous attempt reported concerns, and remediation was decided.',
    '',
  ];
  let summary: string;
  if (trigger === 'validation') {
    lines.push(...validationLines(attempt));
    summary = `validation ${attempt.validation?.status ?? 'failed'}: ${failingChecks(attempt).join(', ') || 'no check details'}`;
  } else {
    const review = state.taskReviews.find((candidate) => candidate.id === reviewId);
    lines.push(...reviewLines(review));
    const blocking = review?.findings.filter((finding) => finding.severity === 'error' || finding.severity === 'critical') ?? [];
    summary = `review ${reviewId?.slice(0, 8) ?? '?'}: ${blocking.length} blocking finding(s): ${blocking.map((finding) => finding.title).join('; ')}`;
  }
  lines.push('', ...changedFileLines(attempt));

  const text = lines.join('\n');
  return {
    text: text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 40)}\n… (evidence truncated by Forge)`,
    summary: truncate(summary, ORCHESTRATION_LIMITS.repairEvidenceSummary),
  };
}

function failingChecks(attempt: TaskAttempt): string[] {
  return (attempt.validation?.checks ?? [])
    .filter((check) => check.required && check.status !== 'passed')
    .map((check) => `${check.id} ${check.status}${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`);
}

function validationLines(attempt: TaskAttempt): string[] {
  const validation = attempt.validation;
  if (validation === null) {
    return ['No validation record is available for the previous attempt.'];
  }
  const lines = [`Deterministic validation result: ${validation.status}`];
  for (const check of validation.checks) {
    lines.push(`- check "${check.id}" (${check.required ? 'required' : 'optional'}): ${check.status}${check.exitCode === null ? '' : `, exit code ${check.exitCode}`}`);
    if (check.status === 'passed') {
      continue;
    }
    if (check.diagnostic !== null) {
      lines.push(`  diagnostic: ${check.diagnostic}`);
    }
    for (const [label, excerpt] of [['stderr', check.stderr], ['stdout', check.stdout]] as const) {
      if (excerpt !== null && excerpt.trim() !== '') {
        lines.push(`  ${label} (excerpt${check.outputTruncated ? ', truncated' : ''}):`, indent(excerpt));
      }
    }
  }
  return lines;
}

function reviewLines(review: TaskReview | undefined): string[] {
  if (review === undefined) {
    return ['The review record is no longer available.'];
  }
  const lines = [`Review status (derived by Forge from finding severities): ${review.status}`];
  if (review.decision !== null) {
    lines.push(`Remediation decided by ${review.decision.by === 'human' ? 'a human' : review.decision.by === 'ai' ? 'the AI decision-maker' : 'Forge orchestration policy'}: ${review.decision.reason}`);
  }
  lines.push('Findings (the reviewer\'s opinion, not verified facts):');
  for (const finding of review.findings) {
    lines.push(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
    if (finding.paths.length > 0) {
      lines.push(`  paths: ${finding.paths.join(', ')}`);
    }
    if (finding.remediation !== null) {
      lines.push(`  suggested remediation: ${finding.remediation}`);
    }
  }
  return lines;
}

function changedFileLines(attempt: TaskAttempt): string[] {
  const files = attempt.changes?.files ?? [];
  if (files.length === 0) {
    return ['The previous attempt changed no files.'];
  }
  return [
    'Files the previous attempt changed (they are still in the working tree):',
    ...files.slice(0, MAX_FILES).map((file) => `- ${file.change} ${file.path}`),
    ...(files.length > MAX_FILES ? [`- … and ${files.length - MAX_FILES} more`] : []),
  ];
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
