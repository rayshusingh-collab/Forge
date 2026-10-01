import { WorkflowError } from '../core/errors.ts';
import { ORCHESTRATION_LIMITS } from '../state/index.ts';
import type {
  AttemptExecutor,
  OrchestrationCounters,
  OrchestrationEvent,
  OrchestrationPolicy,
  OrchestrationRun,
  OrchestrationRunMode,
  OrchestrationStop,
  ProjectState,
} from '../state/index.ts';
import type { ExecutorLiveness } from '../tasks/index.ts';

/**
 * Pure transitions for the bounded orchestration history. Records hold
 * metadata only: actions, outcome codes, short details, counters, and the
 * stop reason — never prompts, diffs, validation output, or provider text.
 */

export const EMPTY_COUNTERS: OrchestrationCounters = { steps: 0, tasks: 0, repairs: 0, reviews: 0, decisions: 0, commits: 0, milestones: 0 };

export interface BeginRunInput {
  readonly id: string;
  readonly mode: OrchestrationRunMode;
  readonly owner: AttemptExecutor;
  readonly policy: OrchestrationPolicy;
  readonly policyHash: string;
  readonly liveness: ExecutorLiveness;
}

/**
 * Records a new running run. A run left `running` by a Forge process that
 * no longer exists is marked `interrupted` (it never recorded how it
 * ended); one whose owner is still alive is refused.
 */
export function beginRun(state: ProjectState, input: BeginRunInput, now: Date): ProjectState {
  const timestamp = now.toISOString();
  const runs = state.orchestrationRuns.map((run): OrchestrationRun => {
    if (run.status !== 'running') {
      return run;
    }
    if (input.liveness(run.owner)) {
      throw new WorkflowError(`Orchestration run ${run.id.slice(0, 8)} (pid ${run.owner.pid} on ${run.owner.host}) is still recorded as active`);
    }
    return { ...run, status: 'interrupted', finishedAt: timestamp };
  });
  const run: OrchestrationRun = {
    id: input.id,
    mode: input.mode,
    status: 'running',
    owner: input.owner,
    startedAt: timestamp,
    finishedAt: null,
    policy: input.policy,
    policyHash: input.policyHash,
    counters: EMPTY_COUNTERS,
    events: [],
    eventsDropped: 0,
    stop: null,
  };
  const all = [...runs, run];
  const excess = Math.max(0, all.length - ORCHESTRATION_LIMITS.retainedRuns);
  return { ...state, orchestrationRuns: all.slice(excess) };
}

export type NewEvent = Omit<OrchestrationEvent, 'at' | 'detail'> & { readonly detail: string | null };

/** Appends one event (dropping the oldest beyond the bound) and stores the run's counters. */
export function recordEvent(state: ProjectState, runId: string, event: NewEvent, counters: OrchestrationCounters, now: Date): ProjectState {
  return updateRun(state, runId, (run) => {
    const stored: OrchestrationEvent = { ...event, at: now.toISOString(), detail: event.detail === null ? null : bounded(event.detail, ORCHESTRATION_LIMITS.eventDetail) };
    const events = [...run.events, stored];
    const excess = Math.max(0, events.length - ORCHESTRATION_LIMITS.eventsPerRun);
    return { ...run, counters, events: events.slice(excess), eventsDropped: run.eventsDropped + excess };
  });
}

export function finishRun(state: ProjectState, runId: string, stop: OrchestrationStop, counters: OrchestrationCounters, now: Date): ProjectState {
  return updateRun(state, runId, (run) => ({
    ...run,
    status: 'stopped',
    finishedAt: now.toISOString(),
    counters,
    stop: { ...stop, detail: stop.detail === null ? null : bounded(stop.detail, ORCHESTRATION_LIMITS.stopDetail) },
  }));
}

function updateRun(state: ProjectState, runId: string, change: (run: OrchestrationRun) => OrchestrationRun): ProjectState {
  const run = state.orchestrationRuns.find((candidate) => candidate.id === runId);
  if (run === undefined || run.status !== 'running') {
    throw new WorkflowError(`Orchestration run ${runId.slice(0, 8)} is not running`);
  }
  return { ...state, orchestrationRuns: state.orchestrationRuns.map((candidate) => (candidate.id === runId ? change(candidate) : candidate)) };
}

export function bounded(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
