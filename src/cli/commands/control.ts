import { randomUUID } from 'node:crypto';

import { StateConflictError } from '../../core/errors.ts';
import { deriveAudit, explain, pauseProject, resumeProject, runPreflight, withKey } from '../../control/index.ts';
import { describeStop, previewRun, resolvePolicy } from '../../orchestration/index.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { acceptedWork, deriveWorkflow } from '../../tasks/index.ts';
import { booleanOption, expectPositionals, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { formatAudit, formatPreflight, preflightSummary } from '../control-format.ts';
import { createRunner, loadProjectSettings, requireConfig, resolveRegistries } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

/**
 * Human control and inspection commands. `pause`/`resume` are the only
 * mutations here; everything else is strictly read-only (no state, config,
 * file, or Git change).
 */

function projectCommand(
  name: string,
  summary: string,
  usage: string,
  options: Parameters<typeof parseCommandArgs>[3],
  action: (parsed: NonNullable<ReturnType<typeof parseCommandArgs>>, context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>,
): CliCommand {
  return {
    name,
    summary,
    usage,
    async run(args, context) {
      const parsed = parseCommandArgs(name, args, context, options);
      if (parsed === undefined || expectPositionals(name, parsed, [], context) === undefined) {
        return ExitCode.Usage;
      }
      const project = await requireProject(name, context);
      return typeof project === 'number' ? project : action(parsed, context, project);
    },
  };
}

export const pauseCommand = projectCommand(
  'pause',
  'Pause the project: refuse autonomous runs and new worker/AI calls until resumed',
  'forge pause --reason <text>\n\nTakes effect before the next orchestration step; a worker already running is not interrupted\n(use Ctrl+C in its terminal for that). Inspection and human decisions still work while paused.',
  { reason: { type: 'string' } },
  async (parsed, context, project) => {
    const reason = stringOption(parsed, 'reason');
    if (reason === undefined) {
      context.stderr.write('forge pause: --reason <text> is required; pauses are recorded\n');
      return ExitCode.Usage;
    }
    try {
      await openStateStore(project).update((state) => pauseProject(state, reason, randomUUID(), new Date()));
    } catch (error) {
      if (error instanceof StateConflictError) {
        context.stderr.write(
          'forge pause: a task is executing right now and holds the project lock, so the pause could not be recorded yet.\n' +
            'Retry `forge pause` when the current step finishes, or press Ctrl+C in the run\'s terminal to cancel it now.\n',
        );
        return ExitCode.Failure;
      }
      throw error;
    }
    context.stdout.write(
      'Project paused. Autonomous runs, worker and AI calls, validation and commits are refused until `forge resume --reason "..."`.\n' +
        'A run already in progress stops before its next step; a worker that is already running is not interrupted.\n',
    );
    return ExitCode.Success;
  },
);

export const resumeCommand = projectCommand(
  'resume',
  'Resume a paused project (explicit, recorded)',
  'forge resume --reason <text>\n\nResuming starts nothing; run `forge run` (or other commands) yourself.',
  { reason: { type: 'string' } },
  async (parsed, context, project) => {
    const reason = stringOption(parsed, 'reason');
    if (reason === undefined) {
      context.stderr.write('forge resume: --reason <text> is required; resumes are recorded\n');
      return ExitCode.Usage;
    }
    await openStateStore(project).update((state) => resumeProject(state, reason, randomUUID(), new Date()));
    context.stdout.write('Project resumed. Nothing was started.\n');
    return ExitCode.Success;
  },
);

export const preflightCommand = projectCommand(
  'preflight',
  'Check that the project is safe and ready for autonomous execution (read-only)',
  'forge preflight [--no-providers]\n\nPASS / WARN / FAIL per check. `forge run` refuses to start while any critical check fails.\n--no-providers skips launching provider health checks.',
  { 'no-providers': { type: 'boolean' } },
  async (parsed, context, project) => {
    const config = requireConfig(context);
    const report = await runPreflight({
      project,
      store: openStateStore(project),
      runner: createRunner(context, config),
      ...(booleanOption(parsed, 'no-providers') ? {} : { registries: resolveRegistries(context) }),
    });
    context.stdout.write(`FORGE PREFLIGHT — ${project.project.name}\n${formatPreflight(report)}${preflightSummary(report)}`);
    return report.ok ? ExitCode.Success : ExitCode.Failure;
  },
);

export const statusCommand = projectCommand(
  'status',
  'Operational overview: pause, runs, next task, blockers, approvals, Git, providers (read-only)',
  'forge status [--no-providers]',
  { 'no-providers': { type: 'boolean' } },
  async (parsed, context, project) => {
    const config = requireConfig(context);
    const store = openStateStore(project);
    const runner = createRunner(context, config);
    const report = await runPreflight({
      project,
      store,
      runner,
      ...(booleanOption(parsed, 'no-providers') ? {} : { registries: resolveRegistries(context) }),
    });
    const lines = [`FORGE STATUS — ${project.project.name} (${project.project.id.slice(0, 8)}, ${project.project.status})`];
    const check = (id: string) => report.checks.find((candidate) => candidate.id === id);
    if (report.state === null || report.config === null) {
      lines.push('Forge cannot read this project\'s state or configuration:', formatPreflight(report, { onlyProblems: true }).trimEnd());
      context.stdout.write(`${lines.join('\n')}\n`);
      return ExitCode.Failure;
    }
    const state = report.state;
    const view = deriveWorkflow(state);
    // Predict with the last run's policy (what the human last chose), else the configured defaults.
    const policy = state.orchestrationRuns.at(-1)?.policy ?? resolvePolicy({}, report.config.settings, { workerTimeoutMs: config.workerTimeoutMs }).policy;
    const preview = await previewRun({ project, store, runner, policy });
    const milestone = view.milestones.find((candidate) => candidate.milestone.status === 'active') ?? view.milestones.find((candidate) => candidate.milestone.status === 'pending');
    const blocked = view.tasks.filter((task) => task.condition === 'blocked' || task.condition === 'exhausted');
    const interrupted = view.tasks.filter((task) => task.condition === 'interrupted');
    const pending = state.approvals.filter((approval) => approval.status === 'pending');
    const uncommitted = view.tasks.filter(
      (task) => task.task.status === 'succeeded' && acceptedWork(task.task).commit === null && (acceptedWork(task.task).changes?.files.length ?? 0) > 0,
    );
    const run = state.orchestrationRuns.at(-1);
    lines.push(
      `Control:          ${state.pause === null ? 'not paused' : `PAUSED since ${state.pause.pausedAt} — ${state.pause.reason}`}; ${preview.lease.held ? `orchestration run ACTIVE (${check('lease')?.detail})` : 'no run active'}`,
      `Current milestone: ${milestone === undefined ? 'none' : `${milestone.milestone.order} ${milestone.milestone.title} (${milestone.milestone.status})`}`,
      `Next runnable:    ${preview.firstRunnable === null ? 'none' : `${preview.firstRunnable.key} ${preview.firstRunnable.task.title}`}`,
      `Blocked:          ${blocked.length === 0 ? 'none' : blocked.map((task) => `${task.key} (${task.condition})`).join(', ')}`,
      `Interrupted:      ${interrupted.length === 0 ? 'none' : interrupted.map((task) => task.key).join(', ')}`,
      `Approvals:        ${pending.length === 0 ? 'none pending' : pending.map((approval) => `${approval.id.slice(0, 8)} ${approval.type}`).join(', ')}`,
      `Last run:         ${run === undefined ? 'none' : `${run.id.slice(0, 8)} ${run.status}${run.stop === null ? '' : ` — ${describeStop(run.stop.reason).label}`}`}`,
      `Validation:       ${check('validation')?.detail ?? '?'}`,
      `Git:              ${check('git')?.detail ?? '?'}`,
      `Uncommitted done: ${uncommitted.length === 0 ? 'none' : uncommitted.map((task) => task.key).join(', ')}`,
    );
    for (const role of report.checks.filter((candidate) => candidate.id.startsWith('provider-'))) {
      lines.push(`${`${role.title}:`.padEnd(18)}${role.status === 'pass' ? '' : `${role.status.toUpperCase()} `}${role.detail}`);
    }
    const next = preview.next;
    const action =
      pending.length > 0
        ? `${pending.length} approval(s) await a decision — forge approval show ${pending[0]!.id.slice(0, 8)}${next.kind === 'stop' ? ` (${describeStop(next.reason).label})` : ''}`
        : next.kind === 'stop'
          ? `${describeStop(next.reason).label} — ${withKey(describeStop(next.reason).action, preview.nextTask?.key ?? null) ?? 'nothing required'}`
          : `none; \`forge run\` would ${next.kind} next (policy of the last run)`;
    lines.push(`Human action:     ${action}`, `Details: forge preflight · forge explain · forge approval list · forge audit`);
    context.stdout.write(`${lines.join('\n')}\n`);
    return ExitCode.Success;
  },
);

export const explainCommand = projectCommand(
  'explain',
  'Explain in plain language why Forge stopped and what to do next (read-only, no AI)',
  'forge explain',
  {},
  async (_parsed, context, project) => {
    const config = requireConfig(context);
    const state = await openStateStore(project).load();
    const lastPolicy = state.orchestrationRuns.at(-1)?.policy;
    const policy = lastPolicy ?? resolvePolicy({}, (await loadProjectSettings(project)).settings, { workerTimeoutMs: config.workerTimeoutMs }).policy;
    context.stdout.write(`${explain({ state, view: deriveWorkflow(state), policy }).join('\n')}\n`);
    return ExitCode.Success;
  },
);

export const auditCommand = projectCommand(
  'audit',
  'Chronological history of plans, tasks, validation, reviews, approvals, runs and human actions (read-only)',
  'forge audit [--limit <n>]   (default 50, at most 500 most recent events)',
  { limit: { type: 'string' } },
  async (parsed, context, project) => {
    const text = stringOption(parsed, 'limit') ?? '50';
    if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 500) {
      context.stderr.write('forge audit: --limit must be a whole number between 1 and 500\n');
      return ExitCode.Usage;
    }
    const state = await openStateStore(project).load();
    const events = deriveAudit(state, deriveWorkflow(state));
    context.stdout.write(formatAudit(events.slice(-Number(text)), events.length));
    return ExitCode.Success;
  },
);
