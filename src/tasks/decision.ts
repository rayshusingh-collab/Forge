import type { ChangeSummary, CommitRecord, HumanRepairRecord, TaskAttempt, TaskRecord, ValidationRecord, WorkerAccessMode } from '../state/index.ts';

/**
 * Forge's decision after a successful worker invocation. Deterministic and
 * pure: it looks only at Forge-collected evidence (the changeset and the
 * validation record), never at what the worker said.
 *
 *   changes outside scope, or HEAD/branch moved  -> scope-violation (failed)
 *   read-only task                                -> awaiting-validation (no code to validate)
 *   no required checks configured                 -> awaiting-validation ("no checks" is not "validated")
 *   validation passed                             -> validated (succeeded)
 *   validation failed or timed out                -> validation-failed (failed)
 *   cancelled / configuration / execution error   -> awaiting-validation (incomplete; re-run it)
 */

export type PostDecision = 'validated' | 'validation-failed' | 'scope-violation' | 'awaiting-validation';

export interface PostExecution {
  readonly changes: ChangeSummary | null;
  readonly validation: ValidationRecord | null;
  readonly decision: PostDecision;
  readonly note: string | null;
}

export function scopeProblem(changes: ChangeSummary | null): string | null {
  if (changes === null) {
    return null;
  }
  if (changes.head !== changes.baseline.head || changes.branch !== changes.baseline.branch) {
    return 'HEAD or the current branch changed during the task';
  }
  if (changes.outOfScope.length > 0) {
    return `changes outside the permitted scope: ${changes.outOfScope.slice(0, 5).join(', ')}`;
  }
  return null;
}

/** Decides before validation runs; returns null when validation should run. */
export function decideBeforeValidation(
  changes: ChangeSummary | null,
  context: { readonly access: WorkerAccessMode; readonly requiredChecks: number },
): PostExecution | null {
  const problem = scopeProblem(changes);
  if (problem !== null) {
    return { changes, validation: null, decision: 'scope-violation', note: problem };
  }
  if (context.access === 'read-only') {
    return { changes, validation: null, decision: 'awaiting-validation', note: 'read-only task: review the result, then override or reject' };
  }
  if (context.requiredChecks === 0) {
    return {
      changes,
      validation: null,
      decision: 'awaiting-validation',
      note: 'no required validation checks are configured; add checks and run `forge task validate`, or override explicitly',
    };
  }
  return null;
}

export function decideFromValidation(changes: ChangeSummary | null, validation: ValidationRecord): PostExecution {
  switch (validation.status) {
    case 'passed':
      return { changes, validation, decision: 'validated', note: null };
    case 'failed':
    case 'timed-out': {
      const failing = validation.checks.filter((check) => check.required && check.status !== 'passed').map((check) => `${check.id} ${check.status}`);
      return { changes, validation, decision: 'validation-failed', note: `required validation ${validation.status}: ${failing.join(', ')}` };
    }
    default:
      return {
        changes,
        validation,
        decision: 'awaiting-validation',
        note: `validation did not complete (${validation.status}); fix the cause and run \`forge task validate\``,
      };
  }
}

/**
 * Whether an attempt's changes can be committed safely, judged from stored
 * evidence alone. `forge task commit` re-verifies against the live
 * repository before doing anything.
 */
export function commitEligibility(attempt: TaskAttempt | undefined): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (attempt === undefined || attempt.outcome !== 'validated') {
    return { ok: false, reason: 'only a task whose latest attempt passed deterministic validation can be committed' };
  }
  return changesEligibility(attempt.changes, attempt.commit);
}

/**
 * Commit eligibility of an accepted human repair: the same rules as for a
 * validated attempt, applied to the changeset Forge measured at acceptance.
 */
export function humanRepairCommitEligibility(repair: HumanRepairRecord | null): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (repair === null || repair.validation.status !== 'passed') {
    return { ok: false, reason: 'only an accepted human repair with passing validation can be committed' };
  }
  return changesEligibility(repair.changes, repair.commit);
}

/**
 * The work a succeeded task is committed from: its accepted human repair
 * when it has one, otherwise its latest attempt.
 */
export function acceptedWork(task: TaskRecord): {
  readonly changes: ChangeSummary | null;
  readonly commit: CommitRecord | null;
  readonly eligibility: { readonly ok: true } | { readonly ok: false; readonly reason: string };
} {
  if (task.humanRepair !== null) {
    return { changes: task.humanRepair.changes, commit: task.humanRepair.commit, eligibility: humanRepairCommitEligibility(task.humanRepair) };
  }
  const last = task.attempts.at(-1);
  return { changes: last?.changes ?? null, commit: last?.commit ?? null, eligibility: commitEligibility(last) };
}

function changesEligibility(changes: ChangeSummary | null, commit: CommitRecord | null): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (commit !== null) {
    return { ok: false, reason: `already committed as ${commit.sha.slice(0, 12)}` };
  }
  if (changes === null || changes.files.length === 0) {
    return { ok: false, reason: 'the task produced no attributed changes' };
  }
  if (changes.truncated || changes.baseline.truncated) {
    return { ok: false, reason: 'too many changed paths to attribute safely' };
  }
  const mixed = changes.files.filter((file) => file.attribution === 'mixed');
  if (mixed.length > 0) {
    return {
      ok: false,
      reason: `${mixed.length} file(s) already had uncommitted changes before the task (${mixed.slice(0, 3).map((f) => f.path).join(', ')}); Forge cannot separate your changes from the task's — commit them yourself`,
    };
  }
  if (changes.indexChanged.length > 0) {
    return { ok: false, reason: `staged changes appeared during the task (${changes.indexChanged.slice(0, 3).join(', ')})` };
  }
  if (changes.files.some((file) => file.change === 'renamed')) {
    return { ok: false, reason: 'staged renames are not committed automatically' };
  }
  const problem = scopeProblem(changes);
  return problem === null ? { ok: true } : { ok: false, reason: problem };
}
