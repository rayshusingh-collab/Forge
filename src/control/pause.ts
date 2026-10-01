import { WorkflowError } from '../core/errors.ts';
import { CONTROL_LIMITS } from '../state/index.ts';
import type { ControlEvent, ControlEventKind, ProjectState } from '../state/index.ts';

/**
 * Project-level human control. Pausing is a deterministic human action
 * (`forge pause`); nothing in Forge's AI roles or worker handling can pause
 * or resume a project.
 *
 * A paused project refuses autonomous runs and every new AI/worker
 * invocation, validation run, and commit. Inspection and human decisions
 * (approvals, cancellations, configuration) still work. Pausing never
 * interrupts a worker that is already running: the orchestrator sees the
 * pause before its next step.
 */

export function pauseProject(state: ProjectState, reason: string, eventId: string, now: Date): ProjectState {
  if (state.pause !== null) {
    throw new WorkflowError(`The project is already paused (since ${state.pause.pausedAt}: ${state.pause.reason})`);
  }
  const text = requireReason(reason);
  const paused = { ...state, pause: { reason: text, pausedAt: now.toISOString(), by: 'human' as const } };
  return appendControlEvent(paused, { id: eventId, kind: 'paused', reason: text, detail: null }, now);
}

export function resumeProject(state: ProjectState, reason: string, eventId: string, now: Date): ProjectState {
  if (state.pause === null) {
    throw new WorkflowError('The project is not paused');
  }
  const text = requireReason(reason);
  return appendControlEvent({ ...state, pause: null }, { id: eventId, kind: 'resumed', reason: text, detail: `paused since ${state.pause.pausedAt}` }, now);
}

/** Refuses `action` while the project is paused. Checked inside state updates, so it is atomic with the action's own first write. */
export function assertNotPaused(state: ProjectState, action: string): void {
  if (state.pause !== null) {
    throw new WorkflowError(
      `The project is paused (since ${state.pause.pausedAt}: ${state.pause.reason}); refusing to ${action}. Resume with: forge resume --reason "..."`,
    );
  }
}

export function appendControlEvent(
  state: ProjectState,
  event: { readonly id: string; readonly kind: ControlEventKind; readonly reason: string | null; readonly detail: string | null },
  now: Date,
): ProjectState {
  const record: ControlEvent = {
    id: event.id,
    at: now.toISOString(),
    kind: event.kind,
    reason: event.reason === null ? null : bound(event.reason, CONTROL_LIMITS.reason),
    detail: event.detail === null ? null : bound(event.detail, CONTROL_LIMITS.detail),
    by: 'human',
  };
  const events = [...state.controlEvents, record];
  return { ...state, controlEvents: events.slice(Math.max(0, events.length - CONTROL_LIMITS.retainedEvents)) };
}

export function requireReason(reason: string): string {
  const text = reason.trim();
  if (text === '' || text.length > CONTROL_LIMITS.reason || text.includes('\0')) {
    throw new WorkflowError(`A reason of 1-${CONTROL_LIMITS.reason} characters is required`);
  }
  return text;
}

function bound(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
