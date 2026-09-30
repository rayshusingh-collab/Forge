import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { decideReview, reviewTask } from '../../review/index.ts';
import type { ProjectState, TaskReview } from '../../state/index.ts';
import { deriveWorkflow, resolveTaskReference } from '../../tasks/index.ts';
import { expectPositionals, parseCommandArgs, stringOption } from '../args.ts';
import { createAiProvider, createRunner, requireConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliContext, ExitCodeValue } from '../types.ts';
import { MAX_TIMEOUT_SECONDS, parseTimeoutSeconds } from './worker.ts';

/**
 * `forge task review | review-show | review-accept | review-reject`.
 * AI review is advisory evidence, separate from deterministic validation;
 * only an explicit human decision has workflow consequences.
 */

export async function reviewCommand(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task review', args, context, { reviewer: { type: 'string' }, timeout: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals('task review', parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const timeoutSeconds = parseTimeoutSeconds(stringOption(parsed, 'timeout'));
  if (timeoutSeconds === 'invalid') {
    context.stderr.write(`forge task review: --timeout must be a whole number of seconds between 1 and ${MAX_TIMEOUT_SECONDS}\n`);
    return ExitCode.Usage;
  }
  const config = requireConfig(context);
  const provider = createAiProvider(stringOption(parsed, 'reviewer') ?? 'claude', 'reviewer', context);
  if (provider === undefined) {
    return ExitCode.Usage;
  }
  context.stderr.write(`Forge is asking AI reviewer "${provider.displayName}" (${provider.id}) for an advisory review. It has no tools and cannot change the project.\n\n`);
  const { review } = await reviewTask({
    project,
    runner: createRunner(context, config),
    provider,
    task: positionals[0]!,
    timeoutMs: timeoutSeconds === undefined ? config.workerTimeoutMs : timeoutSeconds * 1000,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const state = await openStateStore(project).load();
  context.stdout.write(formatReview(review, state));
  context.stdout.write('Nothing was repaired, re-run, or changed in the task’s status.\n');
  return ['clear', 'concerns', 'blocking-concerns'].includes(review.status) ? ExitCode.Success : ExitCode.Failure;
}

export async function reviewShowCommand(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('task review-show', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('task review-show', parsed, ['task'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const state = await openStateStore(project).load();
  const taskId = resolveTaskReference(state, positionals[0]!);
  const reviews = state.taskReviews.filter((review) => review.taskId === taskId);
  if (reviews.length === 0) {
    context.stdout.write('No reviews for this task.\n');
    return ExitCode.Success;
  }
  context.stdout.write(reviews.map((review) => formatReview(review, state)).join('\n'));
  return ExitCode.Success;
}

export async function reviewDecisionCommand(
  kind: 'accepted' | 'remediation-required',
  args: readonly string[],
  context: CliContext,
  project: LoadedProject,
): Promise<ExitCodeValue> {
  const command = kind === 'accepted' ? 'task review-accept' : 'task review-reject';
  const parsed = parseCommandArgs(command, args, context, { reason: { type: 'string' } });
  const positionals = parsed === undefined ? undefined : expectPositionals(command, parsed, ['task'], context);
  if (parsed === undefined || positionals === undefined) {
    return ExitCode.Usage;
  }
  const reason = stringOption(parsed, 'reason');
  if (reason === undefined) {
    context.stderr.write(`forge ${command}: --reason <text> is required; review decisions are recorded\n`);
    return ExitCode.Usage;
  }
  const next = await openStateStore(project).update((state) => decideReview(state, resolveTaskReference(state, positionals[0]!), kind, reason, new Date()));
  const view = deriveWorkflow(next).task(resolveTaskReference(next, positionals[0]!))!;
  context.stdout.write(
    kind === 'accepted'
      ? `Review decision recorded for task ${view.key}: implementation ACCEPTED despite the review. The task remains ${view.task.status}.\n`
      : `Review decision recorded for task ${view.key}: REMEDIATION REQUIRED. The task is now ${view.condition} (attempt evidence and validation history kept).\n` +
          (view.runnable ? `Nothing was started. Run it again explicitly with: forge task run ${view.key} --allow-edits\n` : 'Nothing was started.\n'),
  );
  return ExitCode.Success;
}

export function formatReview(review: TaskReview, state: ProjectState): string {
  const view = deriveWorkflow(state).task(review.taskId);
  const attempt = view?.task.attempts[review.attempt - 1];
  const validation = attempt?.validation;
  const label = review.status.toUpperCase().replace('-', ' ');
  const lines = [
    `Review of task ${view?.key ?? review.taskId} (attempt ${review.attempt}) by ${review.call.provider}: ${label}` +
      (review.recommendation === null ? '' : ` — reviewer recommends "${review.recommendation}" (confidence ${review.confidence})`),
    `  Deterministic validation (separate evidence): ${validation === null || validation === undefined ? 'none' : `${validation.status} (${validation.checks.map((check) => `${check.id} ${check.status}`).join(', ')})`}`,
    `  Evidence sent: ${review.context.files} file(s), ${review.context.bytes} bytes${review.context.truncated ? ', truncated' : ''}; ${(review.call.durationMs / 1000).toFixed(1)} s`,
  ];
  if (review.summary !== null) {
    lines.push(`  Summary: ${review.summary}`);
  }
  if (review.diagnostic !== null) {
    lines.push(`  Problem: ${review.diagnostic}`);
  }
  for (const finding of review.findings) {
    lines.push(`  [${finding.severity}] ${finding.title}${finding.paths.length === 0 ? '' : ` — ${finding.paths.join(', ')}`}`);
    lines.push(`      ${finding.detail.replace(/\s+/g, ' ').slice(0, 400)}`);
    if (finding.remediation !== null) {
      lines.push(`      remediation: ${finding.remediation.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  if (review.decision !== null) {
    lines.push(`  Human decision: ${review.decision.kind} — ${review.decision.reason} (${review.decision.decidedAt})`);
  } else if (['clear', 'concerns', 'blocking-concerns'].includes(review.status)) {
    const key = view?.key ?? review.taskId;
    lines.push(`  Advisory only. Decide with: forge task review-accept ${key} --reason "..."   or   forge task review-reject ${key} --reason "..." (reopens the task)`);
  }
  return `${lines.join('\n')}\n`;
}
