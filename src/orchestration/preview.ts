import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import type { OrchestrationPolicy, OrchestrationRun, StateStore } from '../state/index.ts';
import { deriveWorkflow, processLiveness } from '../tasks/index.ts';
import type { ExecutorLiveness, TaskView } from '../tasks/index.ts';
import { ValidationProfileStore } from '../validation/index.ts';
import { decideNext } from './decision.ts';
import type { NextAction } from './decision.ts';
import { readLeaseStatus } from './lease.ts';
import type { LeaseStatus } from './lease.ts';

/**
 * What `forge run` would do next, computed from persisted state only.
 * Strictly read-only: no worker, reviewer, commit, workflow transition, or
 * file change (Git is queried with optional locks disabled). Used by
 * `forge run --dry-run` and `forge run status`.
 */

export interface RunPreview {
  readonly next: NextAction;
  readonly nextTask: TaskView | null;
  /** The pipeline the next action would go through, in order. */
  readonly expected: readonly string[];
  readonly firstRunnable: TaskView | null;
  /** Tasks needing attention (blocked, exhausted, interrupted, awaiting validation, …). */
  readonly blockers: readonly string[];
  readonly requiredChecks: number;
  readonly unsafeGit: string | null;
  readonly lease: LeaseStatus;
  readonly lastRun: OrchestrationRun | null;
}

export interface PreviewOptions {
  readonly project: LoadedProject;
  readonly store: StateStore;
  readonly runner: ProcessExecutor;
  readonly policy: OrchestrationPolicy;
  readonly liveness?: ExecutorLiveness;
}

/** The run ID a dry run decides with: it matches no attempt, exactly like a fresh run. */
const PREVIEW_RUN_ID = 'dry-run';

export async function previewRun(options: PreviewOptions): Promise<RunPreview> {
  const state = await options.store.load();
  const view = deriveWorkflow(state, options.liveness ?? processLiveness);
  const next = decideNext(state, view, options.policy, { runId: PREVIEW_RUN_ID, tasksStarted: new Set(), reviewsThisRun: new Set() });
  const profile = await new ValidationProfileStore(options.project.layout).load();
  const requiredChecks = profile.checks.filter((check) => check.required).length;
  const nextTask = 'taskId' in next && next.taskId !== null ? (view.task(next.taskId) ?? null) : null;

  let unsafeGit: string | null = null;
  if (options.policy.access === 'edit') {
    try {
      const git = await GitClient.create({ runner: options.runner, root: options.project.layout.root });
      const unmerged = (await git.status()).entries.filter((entry) => entry.kind === 'unmerged');
      unsafeGit = unmerged.length === 0 ? null : `unresolved merge conflicts (${unmerged.slice(0, 3).map((entry) => entry.path).join(', ')})`;
    } catch (error) {
      unsafeGit = `Git state could not be read: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const blockers = view.tasks
    .filter((task) => ['blocked', 'exhausted', 'interrupted', 'awaiting-validation', 'running'].includes(task.condition) || task.requiresIntegrityAcknowledgement)
    .map((task) => `${task.key} ${task.task.title}: ${task.requiresIntegrityAcknowledgement ? `${task.lastAttempt?.outcome} (acknowledgement required)` : task.condition}`);

  return {
    next,
    nextTask,
    expected: expectedPipeline(next, options.policy, requiredChecks),
    firstRunnable: view.runnable[0] ?? null,
    blockers,
    requiredChecks,
    unsafeGit,
    lease: await readLeaseStatus(options.project.layout),
    lastRun: state.orchestrationRuns.at(-1) ?? null,
  };
}

function expectedPipeline(next: NextAction, policy: OrchestrationPolicy, requiredChecks: number): string[] {
  switch (next.kind) {
    case 'execute':
    case 'repair': {
      const steps = [
        next.kind === 'execute'
          ? `run the implementer (${policy.worker}, ${policy.access})`
          : `repair (${next.trigger} evidence) with the implementer (${policy.worker}, ${policy.access})${next.reopen ? ', after recording a policy remediation decision' : ''}`,
      ];
      if (policy.access !== 'edit') {
        steps.push('stop: a read-only task always requires manual validation');
        return steps;
      }
      steps.push(
        requiredChecks === 0
          ? 'stop: no required validation checks are configured, so the task would await manual validation'
          : `run deterministic validation (${requiredChecks} required check(s))`,
      );
      if (requiredChecks > 0) {
        steps.push(
          policy.repair.onValidationFailure ? `on failure: repair (up to ${policy.repair.maxPerTask} per task)` : 'on failure: stop for a human',
          policy.review.enabled ? `on success: AI review by ${policy.review.reviewer} (advisory)` : 'on success: no AI review',
          policy.autoCommit ? 'then: local commit if the safe-commit rules allow it (never pushed)' : 'then: no commit (auto-commit disabled)',
        );
      }
      return steps;
    }
    case 'review':
      return [`AI review by ${policy.review.reviewer} (advisory; the task status does not change)`];
    case 'commit':
      return ['local commit of the task\'s own attributed changes (M5 safe-commit rules; never pushed)'];
    case 'complete-milestone':
      return ['complete the milestone (every task is succeeded or cancelled)'];
    case 'stop':
      return [];
  }
}
