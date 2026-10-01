import type { StopReason } from '../state/index.ts';

/**
 * Why an orchestration run stopped, grouped by what it means:
 * - `complete`   the workflow is finished
 * - `limit`      a configured budget was reached (or a single step was requested); run again to continue
 * - `human`      a human decision or action is required before Forge may continue
 * - `unsafe`     Forge detected a condition it will not act on automatically
 * - `cancelled`  the user interrupted the run
 * - `error`      an unexpected error; nothing further was attempted
 */
export type StopCategory = 'complete' | 'limit' | 'human' | 'unsafe' | 'cancelled' | 'error';

export interface StopReasonInfo {
  /** Upper-case label for terminal output. */
  readonly label: string;
  readonly category: StopCategory;
  /** What a human should do next (null when nothing is required). */
  readonly action: string | null;
}

export const STOP_REASON_INFO: Readonly<Record<StopReason, StopReasonInfo>> = {
  complete: { label: 'COMPLETE', category: 'complete', action: null },
  'no-work': { label: 'NO WORK', category: 'complete', action: 'Create or apply a plan (forge plan create / forge plan apply), or add milestones and tasks.' },
  'step-done': { label: 'STEP DONE', category: 'limit', action: null },
  'limit-steps': { label: 'LIMIT REACHED (steps)', category: 'limit', action: 'Run `forge run` again to continue.' },
  'limit-tasks': { label: 'LIMIT REACHED (tasks)', category: 'limit', action: 'Run `forge run` again to continue.' },
  cancelled: { label: 'CANCELLED', category: 'cancelled', action: 'Inspect the project; run `forge run` again when ready.' },
  'interrupted-task': {
    label: 'INTERRUPTED TASK',
    category: 'human',
    action: 'A previous execution was interrupted. Inspect the project, then run `forge task recover <task>`.',
  },
  'task-running': { label: 'TASK RUNNING ELSEWHERE', category: 'unsafe', action: 'Another Forge process is executing a task; wait for it to finish.' },
  'manual-validation-required': {
    label: 'MANUAL VALIDATION REQUIRED',
    category: 'human',
    action: 'A task is awaiting validation: configure checks and run `forge task validate <task>`, or override/reject it.',
  },
  'integrity-acknowledgement-required': {
    label: 'INTEGRITY VIOLATION — ACKNOWLEDGEMENT REQUIRED',
    category: 'human',
    action: 'Inspect .forge/ and the evidence report; retry manually with `forge task run <task> --acknowledge-integrity-violation`.',
  },
  'scope-acknowledgement-required': {
    label: 'SCOPE VIOLATION — ACKNOWLEDGEMENT REQUIRED',
    category: 'human',
    action: 'Inspect the out-of-scope changes; retry manually with `forge task run <task> --acknowledge-integrity-violation`.',
  },
  'repair-not-permitted': {
    label: 'VALIDATION FAILED — REPAIR NOT PERMITTED',
    category: 'human',
    action: 'Inspect the failure; retry with `forge task run <task>`, or allow repairs with `forge run --repair`.',
  },
  'repair-budget-exhausted': {
    label: 'REPAIR BUDGET EXHAUSTED',
    category: 'human',
    action: 'Inspect the task; retry it manually with `forge task run <task>`, or cancel it.',
  },
  'retry-exhausted': { label: 'RETRY EXHAUSTED', category: 'human', action: 'A task used all its attempts; repair it by hand and run `forge task accept-repair <task> --reason "..."` (required checks must pass), or cancel it, or add a follow-up task.' },
  'worker-failed': {
    label: 'WORKER FAILED',
    category: 'human',
    action: 'The worker did not complete the task (not a validation failure); inspect it and retry with `forge task run <task>`.',
  },
  'review-decision-required': {
    label: 'HUMAN REVIEW REQUIRED',
    category: 'human',
    action: 'Read `forge task review-show <task>`, then `forge task review-accept` or `forge task review-reject` it.',
  },
  'review-remediation-required': {
    label: 'REVIEW REMEDIATION REQUIRED',
    category: 'human',
    action: 'Remediation was required after a review; retry with `forge task run <task>`, or allow it with `forge run --repair-review`.',
  },
  'reviewer-unavailable': {
    label: 'REVIEWER UNAVAILABLE',
    category: 'human',
    action: 'Check the reviewer (`forge doctor`), then run `forge run` again, or `forge task review <task>` yourself.',
  },
  'decision-escalated': {
    label: 'AI DECISION ESCALATED — HUMAN DECISION REQUIRED',
    category: 'human',
    action: 'Read the escalation (`forge task review-show <task>`), then decide: `forge task review-accept <task> --reason "..."` or `forge task review-reject <task> --reason "..."` (or the pending approval).',
  },
  'decision-maker-unavailable': {
    label: 'DECISION-MAKER UNAVAILABLE — HUMAN DECISION REQUIRED',
    category: 'human',
    action: 'The AI decision-maker gave no usable answer (never treated as acceptance). Decide the review yourself (`forge task review-accept|review-reject <task>`), or check the provider (`forge provider check --role decision-maker`) and run again.',
  },
  'commit-refused': {
    label: 'COMMIT REFUSED',
    category: 'human',
    action: 'Forge cannot commit the task\'s changes safely. Commit them yourself, then continue with `forge run` without --auto-commit.',
  },
  'unsafe-git-state': { label: 'UNSAFE GIT STATE', category: 'unsafe', action: 'Resolve the repository state (e.g. merge conflicts), then run `forge run` again.' },
  'provider-unavailable': { label: 'PROVIDER UNAVAILABLE', category: 'unsafe', action: 'Check the worker with `forge doctor`, then run `forge run` again.' },
  blocked: { label: 'BLOCKED', category: 'human', action: 'A dependency can never succeed; cancel or replace the blocked tasks.' },
  'milestone-incomplete': {
    label: 'MILESTONE CANNOT COMPLETE',
    category: 'human',
    action: 'A milestone has no succeeded task (all were cancelled) or no tasks; cancel it or add tasks.',
  },
  'no-runnable-task': { label: 'NO RUNNABLE TASK', category: 'human', action: 'No task can run; inspect `forge task list`.' },
  'integrity-violation': {
    label: 'INTEGRITY VIOLATION',
    category: 'unsafe',
    action: 'Protected Forge state or the project changed unexpectedly; inspect .forge/ and any evidence report.',
  },
  'state-not-recorded': {
    label: 'OUTCOME NOT RECORDED',
    category: 'unsafe',
    action: 'Forge could not record an outcome; inspect the project, then run `forge task recover <task>`.',
  },
  'lease-lost': {
    label: 'ORCHESTRATION LEASE LOST',
    category: 'unsafe',
    action: 'The orchestration lock was removed or replaced during the run; make sure no other `forge run` is active.',
  },
  'step-refused': { label: 'STEP REFUSED', category: 'human', action: 'Forge refused the next step; read the reason and resolve it.' },
  error: { label: 'ERROR', category: 'error', action: 'An unexpected error stopped the run; read the message and inspect the project.' },
  paused: { label: 'PAUSED', category: 'human', action: 'The project is paused; when ready, run `forge resume --reason "..."`.' },
  'approval-rejected': {
    label: 'APPROVAL REJECTED',
    category: 'human',
    action: 'A human rejected the approval Forge needed; resolve the task manually (e.g. `forge task cancel <task>`) or change the situation.',
  },
};

export function describeStop(reason: StopReason): StopReasonInfo {
  return STOP_REASON_INFO[reason];
}
