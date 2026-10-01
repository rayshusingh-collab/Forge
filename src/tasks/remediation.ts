import type { ProjectState } from '../state/index.ts';

/**
 * The outstanding-remediation block every worker attempt of a task
 * receives, whoever started it (orchestrated repair, or a human running
 * `forge task run` again after rejecting a review). Without it a retry sees
 * only the original instruction and may honestly report that nothing needs
 * changing. Requirements are DATA for the worker, fenced like all repair
 * evidence; they are bounded and never truncated silently.
 */

const MAX_BLOCK = 4_000;

export function outstandingRemediationText(state: ProjectState, taskId: string): string | null {
  const open = state.remediations.filter((remediation) => remediation.taskId === taskId && remediation.status === 'open');
  if (open.length === 0) {
    return null;
  }
  const source = (value: string): string => (value === 'ai' ? 'the AI decision-maker' : value === 'policy' ? 'Forge policy' : 'a human');
  const lines = [
    'OUTSTANDING REMEDIATION (required by an earlier review decision; not yet accepted):',
    'This attempt is evaluated against these requirements using the actual changes and check results.',
    'Saying they are done is not evidence: make the observable changes they require (for example add the requested tests or files).',
    ...open.flatMap((remediation) => remediation.requirements.map((requirement) => `- (from attempt ${remediation.fromAttempt}, required by ${source(remediation.source)}) ${requirement}`)),
  ];
  const text = lines.join('\n');
  return text.length <= MAX_BLOCK ? text : `${text.slice(0, MAX_BLOCK - 45)}\n… (further requirements truncated by Forge)`;
}

/** Repair evidence plus the outstanding-remediation block, within `limit` (the evidence is shortened first, visibly). */
export function withOutstandingRemediation(evidence: string | undefined, outstanding: string | null, limit: number): string | undefined {
  if (outstanding === null) {
    return evidence;
  }
  if (evidence === undefined) {
    return outstanding;
  }
  const room = limit - outstanding.length - 2;
  const kept = evidence.length <= room ? evidence : `${evidence.slice(0, Math.max(0, room - 40))}\n… (evidence truncated by Forge)`;
  return `${kept}\n\n${outstanding}`;
}
