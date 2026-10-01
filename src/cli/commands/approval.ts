import { readFile } from 'node:fs/promises';

import { currentFingerprint, leaseApprovalBinding, resolveApproval, resolveApprovalReference, staleApprovals } from '../../approvals/index.ts';
import { WorkflowError } from '../../core/errors.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import type { ApprovalDecision, ApprovalRecord, ProjectState } from '../../state/index.ts';
import { deriveWorkflow } from '../../tasks/index.ts';
import { booleanOption, expectPositionals, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { formatApproval, formatApprovalTable } from '../control-format.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

const USAGE = [
  'forge approval <subcommand>',
  '',
  'Subcommands:',
  '  list [--all]                       Pending, approved and rejected approvals (--all: every record)',
  '  show <approval>                    One approval with its bounded evidence',
  '  approve <approval> --reason <text> Approve a pending request (explicit; recorded)',
  '  reject <approval> --reason <text>  Reject a pending request (explicit; recorded)',
  '',
  'Forge requests approvals when it stops for a human; only you resolve them. An approval',
  'authorizes ONE action, is used at most once by a later `forge run`, and becomes unusable',
  'if the evidence it was bound to changes. Approving never performs work by itself.',
  '<approval> is the full ID or a unique prefix (at least 4 characters).',
].join('\n');

export const approvalCommand: CliCommand = {
  name: 'approval',
  summary: 'List, inspect, approve, or reject the human approvals Forge requested',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      context.stderr.write(`forge approval: ${name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`approval ${name}`, context);
    return typeof project === 'number' ? project : subcommand(rest, context, project);
  },
};

type Subcommand = (args: readonly string[], context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = {
  list,
  show,
  approve: (args, context, project) => decide('approved', args, context, project),
  reject: (args, context, project) => decide('rejected', args, context, project),
};

async function list(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('approval list', args, context, { all: { type: 'boolean' } });
  if (parsed === undefined || expectPositionals('approval list', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const state = await openStateStore(project).load();
  const shown = booleanOption(parsed, 'all') ? state.approvals : state.approvals.filter((approval) => ['pending', 'approved', 'rejected'].includes(approval.status));
  context.stdout.write(formatApprovalTable(shown, deriveWorkflow(state), new Set(staleApprovals(state).map((approval) => approval.id))));
  return ExitCode.Success;
}

async function show(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('approval show', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('approval show', parsed, ['approval'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const state = await openStateStore(project).load();
  const approval = state.approvals.find((candidate) => candidate.id === resolveApprovalReference(state, positionals[0]!))!;
  const stale = staleApprovals(state).some((candidate) => candidate.id === approval.id);
  context.stdout.write(formatApproval(approval, deriveWorkflow(state), stale));
  return ExitCode.Success;
}

/**
 * The ONLY place an approval is resolved. A human must give an explicit
 * subcommand and a reason; there is no default answer, prompt, or timeout.
 */
async function decide(decision: ApprovalDecision, args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const command = `approval ${decision === 'approved' ? 'approve' : 'reject'}`;
  const parsed = parseCommandArgs(command, args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals(command, parsed, ['approval'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write(`forge ${command}: --reason <text> is required; decisions are recorded\n`);
    return ExitCode.Usage;
  }
  const store = openStateStore(project);
  const before = await store.load();
  const id = resolveApprovalReference(before, positionals[0]!);
  const target = before.approvals.find((approval) => approval.id === id)!;
  const leaseFingerprint = target.type === 'lease-recovery' ? await currentLeaseFingerprint(project) : null;

  let stale = false;
  await store.update((state: ProjectState) => {
    const approval = state.approvals.find((candidate) => candidate.id === id)!;
    const fingerprint = approval.type === 'lease-recovery' ? (leaseFingerprint ?? 'missing-lock') : (currentFingerprint(state, approval) ?? 'missing-evidence');
    const result = resolveApproval(state, id, decision, reason, new Date(), fingerprint);
    stale = result.kind === 'stale';
    return result.state;
  });
  if (stale) {
    throw new WorkflowError(
      `Approval ${id.slice(0, 8)} no longer matches the evidence it was requested for (it changed since); it was invalidated and NOT ${decision}. The next \`forge run\` requests a fresh approval if one is still needed.`,
    );
  }
  const view = deriveWorkflow(await store.load());
  const task = target.taskId === null ? undefined : view.task(target.taskId);
  context.stdout.write(
    [
      `Approval ${id.slice(0, 8)} (${target.type}${task === undefined ? '' : ` for task ${task.key}`}) ${decision} by a human. The reason is recorded.`,
      decision === 'approved'
        ? nextStep(target)
        : 'Nothing will use it. Forge stops at this point while the evidence is unchanged; resolve the situation manually.',
      'Nothing was executed by this command.',
      '',
    ].join('\n'),
  );
  return ExitCode.Success;
}

function nextStep(approval: ApprovalRecord): string {
  return approval.type === 'lease-recovery'
    ? 'Run `forge run recover --force --reason "..."` to use it (the lock must be unchanged).'
    : 'The next `forge run` (or `forge run step`) uses it once, if the evidence is still unchanged.';
}

async function currentLeaseFingerprint(project: LoadedProject): Promise<string | null> {
  try {
    return leaseApprovalBinding(await readFile(project.layout.orchestrationLockFile, 'utf8'), '').fingerprint;
  } catch {
    return null;
  }
}
