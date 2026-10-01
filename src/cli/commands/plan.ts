import { randomUUID } from 'node:crypto';

import { createPlan, previewPlanningContext, applyPlan, rejectPlan, resolvePlanReference, shortPlanId } from '../../planning/index.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import type { PlanProposal } from '../../state/index.ts';
import { deriveWorkflow } from '../../tasks/index.ts';
import { expectPositionals, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { roleProvider } from '../../control/index.ts';
import { createAiProvider, createRunner, lenientConfig, requireConfig, loadProjectSettings } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { MAX_TIMEOUT_SECONDS, parseTimeoutSeconds } from './worker.ts';

const USAGE = [
  'forge plan <subcommand>',
  '',
  'Subcommands:',
  '  create --goal <text> [--planner <name>] [--timeout <seconds>]',
  '                        Ask an AI planner for a PROPOSED plan (creates no work, runs nothing)',
  '  list                  List plan proposals',
  '  show <plan>           Show a proposal: milestones, tasks, dependencies, assumptions, risks',
  '  apply <plan>          Turn a proposal into milestones and tasks (a human decision; starts nothing)',
  '  reject <plan> --reason <text>',
  '                        Reject a proposal (it can never be applied)',
  '  context               Show what a planner would receive (files and limits), without calling it',
  '',
  'Planner proposes; you approve; workers implement; validation proves; Forge controls state.',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { create, list, show, apply, reject, context: preview };

export const planCommand: CliCommand = {
  name: 'plan',
  summary: 'Ask an AI planner for plan proposals, and apply or reject them',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge plan: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`plan ${name}`, context);
    if (typeof project === 'number') {
      return project;
    }
    return subcommand(rest, context, project);
  },
};

async function create(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan create', args, context, {
    goal: { type: 'string' },
    planner: { type: 'string' },
    timeout: { type: 'string' },
  });
  if (parsed === undefined || expectPositionals('plan create', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const goal = stringOption(parsed, 'goal');
  if (goal === undefined) {
    context.stderr.write('forge plan create: --goal <text> is required\n');
    return ExitCode.Usage;
  }
  const timeoutSeconds = parseTimeoutSeconds(stringOption(parsed, 'timeout'));
  if (timeoutSeconds === 'invalid') {
    context.stderr.write(`forge plan create: --timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}\n`);
    return ExitCode.Usage;
  }
  const config = requireConfig(context);
  const provider = createAiProvider(roleProvider('planner', (await loadProjectSettings(project)).settings, stringOption(parsed, 'planner')).name, 'planner', context);
  if (provider === undefined) {
    return ExitCode.Usage;
  }

  context.stderr.write(`Forge is asking AI planner "${provider.displayName}" (${provider.id}) for a plan proposal. It has no tools and cannot change the project.\n\n`);
  const result = await createPlan({
    project,
    runner: createRunner(context, config),
    provider,
    goal,
    timeoutMs: timeoutSeconds === undefined ? config.workerTimeoutMs : timeoutSeconds * 1000,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  if (!result.ok) {
    context.stderr.write(`forge plan create: no plan was recorded — planner ${result.outcome}: ${result.diagnostic}\n`);
    return ExitCode.Failure;
  }
  context.stdout.write(`${formatProposal(result.proposal)}\nNothing was created or started. Next: forge plan apply ${shortPlanId(result.proposal.id)}   or   forge plan reject ${shortPlanId(result.proposal.id)} --reason "..."\n`);
  return ExitCode.Success;
}

async function list(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan list', args, context, {});
  if (parsed === undefined || expectPositionals('plan list', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const proposals = (await openStateStore(project).load()).planProposals;
  if (proposals.length === 0) {
    context.stdout.write('No plan proposals. Create one with: forge plan create --goal "..."\n');
    return ExitCode.Success;
  }
  for (const proposal of proposals) {
    context.stdout.write(
      `${shortPlanId(proposal.id)}  ${proposal.status.padEnd(8)}  ${proposal.plan.milestones.length} milestone(s), ${proposal.plan.tasks.length} task(s)  ${proposal.createdAt}  ${oneLine(proposal.goal, 70)}\n`,
    );
  }
  return ExitCode.Success;
}

async function show(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan show', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('plan show', parsed, ['plan'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const state = await openStateStore(project).load();
  const id = resolvePlanReference(state, positionals[0]!);
  context.stdout.write(formatProposal(state.planProposals.find((proposal) => proposal.id === id)!));
  return ExitCode.Success;
}

async function apply(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan apply', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('plan apply', parsed, ['plan'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const next = await openStateStore(project).update((state) => applyPlan(state, resolvePlanReference(state, positionals[0]!), randomUUID, new Date()));
  const proposal = next.planProposals.find((candidate) => candidate.id === resolvePlanReference(next, positionals[0]!))!;
  const view = deriveWorkflow(next);
  const keys = proposal.appliedTasks.map((mapping) => view.task(mapping.forgeId)?.key ?? '?');
  context.stdout.write(
    [
      `Applied plan ${shortPlanId(proposal.id)}: ${proposal.appliedMilestones.length} milestone(s), ${proposal.appliedTasks.length} task(s) (${keys.join(', ')}).`,
      view.runnable.length === 0 ? 'Runnable now: none' : `Runnable now: ${view.runnable.map((task) => task.key).join(', ')}`,
      'Nothing was started, and no files or validation checks were changed.',
      '',
    ].join('\n'),
  );
  return ExitCode.Success;
}

async function reject(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan reject', args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('plan reject', parsed, ['plan'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write('forge plan reject: --reason <text> is required\n');
    return ExitCode.Usage;
  }
  await openStateStore(project).update((state) => rejectPlan(state, resolvePlanReference(state, positionals[0]!), reason, new Date()));
  context.stdout.write(`Plan ${positionals[0]} rejected. It can no longer be applied.\n`);
  return ExitCode.Success;
}

async function preview(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('plan context', args, context, {});
  if (parsed === undefined || expectPositionals('plan context', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const collected = await previewPlanningContext(project, createRunner(context, lenientConfig(context)));
  context.stdout.write(
    [
      `Files with content (${collected.files.length}, ${collected.bytes} bytes${collected.truncated ? ', TRUNCATED' : ''}):`,
      ...collected.files.map((file) => `  ${file.path}  ${file.bytes} B${file.truncated ? ' (truncated)' : ''}`),
      `Tree entries: ${collected.tree.length}${collected.treeTruncated ? ' (truncated)' : ''}`,
      `Withheld: ${collected.omitted.sensitive} secret-like, ${collected.omitted.protected} protected, ${collected.omitted.generated} generated, ${collected.omitted.binary} binary, ${collected.omitted.overLimit} over limits`,
      'Git-ignored files (e.g. .env) are never listed or read.',
      '',
    ].join('\n'),
  );
  return ExitCode.Success;
}

export function formatProposal(proposal: PlanProposal): string {
  const plan = proposal.plan;
  const lines = [
    `Plan ${shortPlanId(proposal.id)} — ${proposal.status.toUpperCase()}${proposal.status === 'proposed' ? ' (a proposal: not work until applied)' : ''}`,
    `  Goal:     ${proposal.goal}`,
    `  Planner:  ${proposal.call.provider} (${(proposal.call.durationMs / 1000).toFixed(1)} s${proposal.call.costUsd === null ? '' : `, $${proposal.call.costUsd.toFixed(4)}`})`,
    `  Context:  ${proposal.context.files} file(s), ${proposal.context.bytes} bytes${proposal.context.truncated ? ', truncated' : ''}`,
    `  Summary:  ${plan.summary}`,
  ];
  if (proposal.reason !== null) {
    lines.push(`  Rejected: ${proposal.reason}`);
  }
  if (plan.assumptions.length > 0) {
    lines.push('  Assumptions:', ...plan.assumptions.map((item) => `    - ${item}`));
  }
  lines.push('  Milestones and tasks:');
  for (const milestone of plan.milestones) {
    lines.push(`    ${milestone.id}  ${milestone.title}`);
    for (const task of plan.tasks.filter((candidate) => candidate.milestone === milestone.id)) {
      const deps = task.dependsOn.length === 0 ? '' : `   (after ${task.dependsOn.join(', ')})`;
      lines.push(`      ${task.id}  ${task.title}${deps}`);
      lines.push(`          ${oneLine(task.instruction, 160)}`);
      if (task.suggestedValidation.length > 0) {
        lines.push(`          suggested checks (informational, not configured): ${task.suggestedValidation.join('; ')}`);
      }
    }
  }
  if (plan.risks.length > 0) {
    lines.push('  Risks:', ...plan.risks.map((item) => `    - ${item}`));
  }
  if (plan.notes !== null) {
    lines.push(`  Notes:    ${oneLine(plan.notes, 300)}`);
  }
  return `${lines.join('\n')}\n`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
