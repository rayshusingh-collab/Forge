import type { EffectiveSetting } from '../config/index.ts';
import type { AuditEvent, PreflightReport, RoleHealth } from '../control/index.ts';
import type { ApprovalRecord } from '../state/index.ts';
import type { WorkflowView } from '../tasks/index.ts';

/**
 * Terminal output for the human-control commands. Concise, bounded, and
 * built from Forge's own records only.
 */

const MARK = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;

export function formatPreflight(report: PreflightReport, options: { readonly onlyProblems?: boolean } = {}): string {
  const checks = options.onlyProblems === true ? report.checks.filter((check) => check.status !== 'pass') : report.checks;
  const width = Math.max(0, ...checks.map((check) => check.title.length));
  const lines = checks.flatMap((check) => [
    `  [${MARK[check.status]}] ${check.title.padEnd(width)}  ${check.detail}${check.critical && check.status === 'fail' ? '  (blocks forge run)' : ''}`,
    ...(check.action === null ? [] : [`         ${' '.repeat(width)}  → ${check.action}`]),
  ]);
  return `${lines.join('\n')}\n`;
}

export function preflightSummary(report: PreflightReport): string {
  const count = (status: 'pass' | 'warn' | 'fail'): number => report.checks.filter((check) => check.status === status).length;
  const verdict = !report.runnable ? 'NOT READY: autonomous runs are refused' : count('warn') > 0 ? 'READY WITH WARNINGS' : 'READY';
  return `${verdict} (${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail)\n`;
}

export function approvalStatusLabel(approval: ApprovalRecord, stale: boolean): string {
  return stale ? `${approval.status.toUpperCase()} (STALE: evidence changed; it can no longer be used)` : approval.status.toUpperCase();
}

export function formatApprovalTable(approvals: readonly ApprovalRecord[], view: WorkflowView, stale: ReadonlySet<string>): string {
  if (approvals.length === 0) {
    return 'No approvals.\n';
  }
  const rows = approvals.map((approval) => [
    approval.id.slice(0, 8),
    approval.status === 'pending' && stale.has(approval.id) ? 'pending*' : approval.status,
    approval.type,
    approval.taskId === null ? '-' : (view.task(approval.taskId)?.key ?? approval.taskId.slice(0, 8)),
    approval.createdAt.slice(0, 19).replace('T', ' '),
    approval.reason.length <= 70 ? approval.reason : `${approval.reason.slice(0, 69)}…`,
  ]);
  const header = ['ID', 'STATUS', 'TYPE', 'TASK', 'CREATED', 'REASON'];
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
  const render = (row: readonly string[]): string => row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]!))).join('  ');
  const note = rows.some((row) => row[1] === 'pending*') ? '\n* the evidence changed since the request; the next run (or a decision attempt) invalidates it' : '';
  return `${[render(header), ...rows.map(render)].join('\n')}${note}\n`;
}

export function formatApproval(approval: ApprovalRecord, view: WorkflowView, stale: boolean): string {
  const task = approval.taskId === null ? null : view.task(approval.taskId);
  const lines = [
    `Approval ${approval.id}`,
    `Type:             ${approval.type}`,
    `Status:           ${approvalStatusLabel(approval, stale)}`,
    `Task:             ${task === null ? '-' : task === undefined ? approval.taskId : `${task.key} ${task.task.title}`}`,
    `Requested:        ${approval.createdAt}${approval.runId === null ? '' : ` (run ${approval.runId.slice(0, 8)})`}`,
    `Why Forge asks:   ${approval.reason}`,
    'Evidence (bounded summary):',
    ...approval.evidence.map((line) => `  - ${line}`),
    `Approving allows: ${approval.requestedAction}`,
    `Bound to:         ${approval.boundTo}`,
    `Fingerprint:      ${approval.fingerprint.slice(0, 16)}… (any change to that evidence makes this approval unusable)`,
  ];
  if (approval.resolution !== null) {
    lines.push(`Decision:         ${approval.resolution.decision} by a human at ${approval.resolution.at}: ${approval.resolution.reason}`);
  }
  if (approval.consumedAt !== null) {
    lines.push(`Used:             ${approval.consumedAt} by run ${approval.consumedByRunId?.slice(0, 8)}`);
  }
  if (approval.invalidatedAt !== null) {
    lines.push(`Invalidated:      ${approval.invalidatedAt}: ${approval.invalidationReason}`);
  }
  if (approval.status === 'pending' && !stale) {
    lines.push('', `Approve: forge approval approve ${approval.id.slice(0, 8)} --reason "..."`, `Reject:  forge approval reject ${approval.id.slice(0, 8)} --reason "..."`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatAudit(events: readonly AuditEvent[], total: number): string {
  if (events.length === 0) {
    return 'No recorded history yet.\n';
  }
  const lines = events.map((event) => `${event.at.slice(0, 19).replace('T', ' ')}  ${event.kind.padEnd(20)}  ${event.subject.padEnd(16)}  ${event.detail}`);
  const note = total > events.length ? [`(${total - events.length} older event(s) not shown; use --limit)`] : [];
  return `${[...note, ...lines].join('\n')}\n`;
}

export function formatEffectiveConfig(settings: readonly EffectiveSetting[]): string {
  const width = Math.max(...settings.map((setting) => setting.key.length));
  const lines = settings.map((setting) => `${setting.key.padEnd(width)}  ${String(setting.value ?? '-').padEnd(8)}  ${setting.source.padEnd(11)}  ${setting.description}`);
  return `${[`${'KEY'.padEnd(width)}  ${'VALUE'.padEnd(8)}  ${'SOURCE'.padEnd(11)}  DESCRIPTION`, ...lines].join('\n')}\n`;
}

export function formatRoleHealth(roles: readonly RoleHealth[]): string {
  return `${roles
    .map((role) => `  [${role.available ? 'PASS' : 'FAIL'}] ${role.role.padEnd(14)}  ${role.configured} (${role.source})${role.providerId === null ? '' : ` → ${role.providerId}`}: ${role.detail}`)
    .join('\n')}\n`;
}
