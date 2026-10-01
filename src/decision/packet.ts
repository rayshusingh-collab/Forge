import { dataBlock } from '../ai/envelope.ts';
import type { GitClient } from '../git/index.ts';
import { presentChanges } from '../review/index.ts';
import type { ReviewPacketLimits } from '../review/index.ts';
import type { ContextSummary, ProjectState, RemediationRecord, TaskAttempt, TaskRecord, TaskReview } from '../state/index.ts';
import { commitEligibility, repairsUsed } from '../tasks/index.ts';
import type { ValidationProfile } from '../validation/index.ts';

/**
 * The bounded evidence the AI decision-maker receives about ONE validated
 * attempt and its review. Deterministic for the same records and files.
 * Every block says how much to trust it: Forge's records are evidence, the
 * review is advisory, the worker's summary is an untrusted claim.
 *
 * Nothing beyond the task's own records and attributed changes is included:
 * no other files, no environment, no check output beyond Forge's stored
 * excerpts of FAILED checks (and here every required check passed).
 */

export const DEFAULT_DECISION_LIMITS: ReviewPacketLimits = { maxFiles: 40, maxBytes: 80_000, maxFileBytes: 8_000 };

const MAX_HISTORY_ATTEMPTS = 10;
const MAX_HISTORY_REVIEWS = 5;
const MAX_HISTORY_DECISIONS = 5;
const MAX_LINE = 400;

export interface OutstandingRequirement {
  /** `R1`, `R2`, … in presentation order. */
  readonly label: string;
  readonly remediationId: string;
  readonly text: string;
}

export interface DecisionPacket {
  readonly text: string;
  readonly summary: ContextSummary;
  readonly requirements: readonly OutstandingRequirement[];
  /** Per outstanding remediation, attributed files changed since the attempt that required it (null: unknown). */
  readonly changesSinceRemediation: readonly (number | null)[];
  /** 1-based numbers of the findings (warning or above) the answer must assess. */
  readonly findingsToAssess: readonly number[];
}

export interface DecisionPacketInput {
  readonly git: GitClient;
  readonly state: ProjectState;
  readonly task: TaskRecord;
  readonly taskKey: string;
  readonly attempt: TaskAttempt;
  readonly review: TaskReview;
  readonly profile: ValidationProfile;
  readonly maxRepairs: number;
  readonly limits?: ReviewPacketLimits;
}

export async function buildDecisionPacket(input: DecisionPacketInput): Promise<DecisionPacket> {
  const { state, task, attempt, review } = input;
  const run = state.workerRuns.find((candidate) => candidate.id === attempt.runId);
  const milestone = state.milestones.find((candidate) => candidate.id === task.milestoneId);
  const open = state.remediations.filter((remediation) => remediation.taskId === task.id && remediation.status === 'open');

  const requirements: OutstandingRequirement[] = [];
  const sinceLines: string[] = [];
  const changesSinceRemediation: (number | null)[] = [];
  for (const remediation of open) {
    const labels: string[] = [];
    for (const text of remediation.requirements) {
      const label = `R${requirements.length + 1}`;
      requirements.push({ label, remediationId: remediation.id, text });
      labels.push(label);
    }
    const since = changedSince(task.attempts[remediation.fromAttempt - 1], attempt);
    changesSinceRemediation.push(since === null ? null : since.length);
    sinceLines.push(
      `${labels.join(', ')}: ${
        since === null ? 'changes since then cannot be measured' : since.length === 0 ? `NO attributed file changed since attempt ${remediation.fromAttempt}` : `changed since attempt ${remediation.fromAttempt}: ${since.slice(0, 30).join(', ')}${since.length > 30 ? ` … (+${since.length - 30})` : ''}`
      }`,
    );
  }

  const findingsToAssess = review.findings.flatMap((finding, index) => (finding.severity === 'info' ? [] : [index + 1]));
  const validation = attempt.validation;
  const eligibility = commitEligibility(attempt);
  const mixed = attempt.changes?.files.filter((file) => file.attribution === 'mixed').length ?? 0;

  const blocks = [
    dataBlock(
      'task',
      [
        `task ${input.taskKey}: ${task.title}`,
        `milestone: ${milestone?.title ?? task.milestoneId}`,
        `attempt ${attempt.number} of at most ${task.maxAttempts}; repairs used ${repairsUsed(task)} of ${input.maxRepairs}`,
        'instruction:',
        task.instruction,
        ...(task.context === null ? [] : ['context:', task.context]),
      ].join('\n'),
    ),
    dataBlock(
      'deterministic-validation',
      [
        '(Forge ran these checks itself: EVIDENCE. Only the behaviour these checks actually exercise is proven.)',
        validation === null ? 'no validation record' : `overall: ${validation.status}`,
        ...(validation?.checks ?? []).map((check) => `- ${check.id} (${check.required ? 'required' : 'optional'}): ${check.status}`),
      ].join('\n'),
    ),
    dataBlock(
      'validation-profile',
      [
        '(the checks configured for this project and the program each one runs)',
        ...(input.profile.checks.length === 0
          ? ['none configured']
          : input.profile.checks.map((check) => clip(`- ${check.id} (${check.required ? 'required' : 'optional'}): ${[check.executable, ...check.args].join(' ')}`))),
      ].join('\n'),
    ),
    dataBlock(
      'safety',
      [
        '(Forge\'s own verification of this attempt: EVIDENCE)',
        'Forge-control-state integrity: verified unchanged during the attempt',
        `scope: ${attempt.changes === null ? 'no changes recorded' : attempt.changes.outOfScope.length === 0 ? 'no out-of-scope changes; HEAD and branch unchanged since the task began' : 'OUT-OF-SCOPE CHANGES PRESENT'}`,
        `Git attribution: ${mixed === 0 ? 'every changed file is attributed to this task' : `${mixed} file(s) MIXED with changes made before the task`}`,
        `safe-commit eligibility: ${eligibility.ok ? 'eligible' : `not eligible (${eligibility.reason})`} — committing is decided by Forge's safe-commit rules, never by you`,
      ].join('\n'),
    ),
    dataBlock(
      'worker-claim',
      [`UNTRUSTED CLAIM by implementer "${run?.worker ?? 'unknown'}" — not evidence; verify it against the changes and checks:`, clip(run?.summary ?? '(none)', 2_000)].join('\n'),
    ),
    dataBlock('review', describeReview(review, true), { id: review.id.slice(0, 8) }),
    dataBlock(
      'outstanding-remediation',
      requirements.length === 0
        ? 'none: no earlier decision required remediation of this task'
        : [
            'Required by earlier review decisions and NOT yet accepted. Assess each against THIS attempt\'s evidence:',
            ...open.flatMap((remediation) =>
              requirements
                .filter((requirement) => requirement.remediationId === remediation.id)
                .map((requirement) => `${requirement.label} (from attempt ${remediation.fromAttempt}, decided by ${describeSource(remediation)}): ${clip(requirement.text, 1_000)}`),
            ),
            '',
            'Observable changes since each requirement was made (fingerprints of attributed files):',
            ...sinceLines,
          ].join('\n'),
    ),
    dataBlock('history', historyLines(state, task, attempt.number).join('\n')),
  ];

  const presented = await presentChanges(input.git, attempt.changes, input.limits ?? DEFAULT_DECISION_LIMITS);
  blocks.push(...presented.blocks);
  blocks.unshift(
    dataBlock(
      'decision-notes',
      [
        `changed files: ${presented.changedFiles}; shown with content: ${presented.summary.files}`,
        presented.summary.truncated ? 'the change evidence is TRUNCATED; unseen code is neither proven correct nor incorrect' : 'the change evidence is complete within the limits',
        `reviewer findings to assess: ${findingsToAssess.length === 0 ? 'none' : findingsToAssess.join(', ')}; outstanding requirements: ${requirements.length === 0 ? 'none' : requirements.map((r) => r.label).join(', ')}`,
      ].join('\n'),
    ),
  );

  return { text: blocks.join('\n\n'), summary: presented.summary, requirements, changesSinceRemediation, findingsToAssess };
}

/**
 * Attributed files whose content differs between two attempts' recorded
 * changesets (added, modified, or no longer changed). Null when either
 * attempt has no recorded changes.
 */
export function changedSince(source: TaskAttempt | undefined, current: TaskAttempt): string[] | null {
  if (source === undefined || source.changes === null || current.changes === null) {
    return null;
  }
  const before = new Map(source.changes.files.map((file) => [file.path, file.fingerprint]));
  const after = new Map(current.changes.files.map((file) => [file.path, file.fingerprint]));
  const changed: string[] = [];
  for (const [path, fingerprint] of after) {
    if (before.get(path) !== fingerprint) {
      changed.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      changed.push(`${path} (reverted)`);
    }
  }
  return changed.sort();
}

function describeReview(review: TaskReview, numbered: boolean): string {
  return [
    `(ADVISORY: the reviewer's opinion, not verified fact; Forge derived status "${review.status}" from the severities)`,
    `reviewer: ${review.call.provider}; recommendation: ${review.recommendation ?? '-'} (confidence ${review.confidence ?? '-'})`,
    ...(review.summary === null ? [] : [`summary: ${clip(review.summary, 1_000)}`]),
    ...review.findings.map(
      (finding, index) =>
        `${numbered ? `finding ${index + 1} ` : ''}[${finding.severity}] ${clip(finding.title, 200)}: ${clip(finding.detail, 800)}${finding.paths.length === 0 ? '' : ` (paths: ${finding.paths.join(', ')})`}${finding.remediation === null ? '' : ` — suggested: ${clip(finding.remediation, 400)}`}`,
    ),
  ].join('\n');
}

function historyLines(state: ProjectState, task: TaskRecord, current: number): string[] {
  const lines = ['Earlier attempts (Forge records):'];
  const earlier = task.attempts.filter((attempt) => attempt.number < current).slice(-MAX_HISTORY_ATTEMPTS);
  if (earlier.length === 0) {
    lines.push('- none');
  }
  for (const attempt of earlier) {
    const origin = attempt.origin === null ? 'manual' : attempt.origin.repair === null ? 'orchestrated' : `repair ${attempt.origin.repair.number} (${attempt.origin.repair.trigger})`;
    lines.push(clip(`- attempt ${attempt.number} (${origin}): ${attempt.outcome}; validation ${attempt.validation?.status ?? 'not run'}; ${attempt.changes?.files.length ?? 0} file(s) changed${attempt.note === null ? '' : ` — ${attempt.note}`}`));
  }
  const reviews = state.taskReviews.filter((review) => review.taskId === task.id && review.attempt < current).slice(-MAX_HISTORY_REVIEWS);
  lines.push('Earlier reviews and their decisions:');
  if (reviews.length === 0) {
    lines.push('- none');
  }
  for (const review of reviews) {
    lines.push(clip(`- attempt ${review.attempt}: ${review.status}${review.decision === null ? '; undecided' : `; decided ${review.decision.kind} by ${review.decision.by}: ${review.decision.reason}`}`));
    for (const finding of review.findings.filter((item) => item.severity !== 'info').slice(0, 5)) {
      lines.push(clip(`    [${finding.severity}] ${finding.title}`));
    }
  }
  const decisions = state.aiDecisions.filter((decision) => decision.taskId === task.id).slice(-MAX_HISTORY_DECISIONS);
  lines.push('Earlier AI decisions:');
  if (decisions.length === 0) {
    lines.push('- none');
  }
  for (const decision of decisions) {
    lines.push(clip(`- attempt ${decision.attempt}: ${decision.verdict ?? decision.status} -> ${decision.effect}${decision.reason === null ? '' : ` — ${decision.reason}`}`));
  }
  const satisfied = state.remediations.filter((remediation) => remediation.taskId === task.id && remediation.status === 'satisfied');
  for (const remediation of satisfied) {
    lines.push(clip(`- remediation from attempt ${remediation.fromAttempt} was accepted as satisfied: ${remediation.requirements.join('; ')}`));
  }
  return lines;
}

function describeSource(remediation: RemediationRecord): string {
  return remediation.source === 'ai' ? 'the AI decision-maker' : remediation.source === 'policy' ? 'Forge policy' : 'a human';
}

function clip(text: string, max = MAX_LINE): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
