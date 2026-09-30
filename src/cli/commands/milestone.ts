import { TaskEngine, resolveMilestoneReference } from '../../tasks/index.ts';
import { expectPositionals, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { formatMilestone, formatMilestoneList } from '../workflow-format.ts';

const USAGE = [
  'forge milestone <subcommand>',
  '',
  'Subcommands:',
  '  add --title <text> [--description <text>]   Add a milestone (appended to the order)',
  '  list                                         List milestones in order',
  '  show <milestone>                             Show a milestone and its tasks',
  '  complete <milestone>                         Complete it (all tasks succeeded or cancelled)',
  '  cancel <milestone> [--reason <text>]         Cancel it and its unfinished tasks',
  '',
  '<milestone> is its number (e.g. 2), full ID, or a unique ID prefix (4+ characters).',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext, engine: TaskEngine) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { add, list, show, complete, cancel };

export const milestoneCommand: CliCommand = {
  name: 'milestone',
  summary: 'Create and manage milestones',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge milestone: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`milestone ${name}`, context);
    if (typeof project === 'number') {
      return project;
    }
    return subcommand(rest, context, new TaskEngine({ project }));
  },
};

async function add(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('milestone add', args, context, { title: { type: 'string' }, description: { type: 'string' } });
  if (parsed === undefined || expectPositionals('milestone add', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const title = stringOption(parsed, 'title');
  if (title === undefined) {
    context.stderr.write('forge milestone add: --title <text> is required\n');
    return ExitCode.Usage;
  }
  const milestone = await engine.addMilestone({ title, description: stringOption(parsed, 'description') ?? null });
  context.stdout.write(`Added milestone ${milestone.order}: ${milestone.title} (${milestone.id})\n`);
  return ExitCode.Success;
}

async function list(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('milestone list', args, context, {});
  if (parsed === undefined || expectPositionals('milestone list', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  context.stdout.write(formatMilestoneList(await engine.view()));
  return ExitCode.Success;
}

async function show(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('milestone show', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('milestone show', parsed, ['milestone'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const state = await engine.load();
  const id = resolveMilestoneReference(state, positionals[0]!);
  const view = await engine.view();
  context.stdout.write(formatMilestone(view.milestone(id)!, view));
  return ExitCode.Success;
}

async function complete(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('milestone complete', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('milestone complete', parsed, ['milestone'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  await engine.completeMilestone(positionals[0]!);
  context.stdout.write(`Milestone ${positionals[0]} completed.\n`);
  return ExitCode.Success;
}

async function cancel(args: readonly string[], context: CliContext, engine: TaskEngine): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('milestone cancel', args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('milestone cancel', parsed, ['milestone'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  await engine.cancelMilestone(positionals[0]!, stringOption(parsed, 'reason') ?? null);
  context.stdout.write(`Milestone ${positionals[0]} cancelled, along with its unfinished tasks.\n`);
  return ExitCode.Success;
}
