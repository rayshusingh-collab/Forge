import { randomUUID } from 'node:crypto';

import { WorkflowError } from '../core/errors.ts';
import { runReadOnly } from '../ai/read-only-guard.ts';
import type { AiProvider } from '../ai/types.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import { openStateStore } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { AI_LIMITS } from '../state/index.ts';
import type { StateStore, TaskReview } from '../state/index.ts';
import { resolveTaskReference } from '../tasks/index.ts';
import { ValidationProfileStore } from '../validation/index.ts';
import { DEFAULT_REVIEW_LIMITS, buildReviewPacket } from './packet.ts';
import type { ReviewPacket, ReviewPacketLimits } from './packet.ts';
import { buildReviewerRequest, deriveReviewStatus, parseReviewResponse } from './reviewer.ts';
import { recordReview } from './transitions.ts';

export interface ReviewTaskOptions {
  readonly project: LoadedProject;
  readonly runner: ProcessExecutor;
  readonly provider: AiProvider;
  readonly task: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly store?: StateStore;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
  readonly limits?: ReviewPacketLimits;
}

export interface ReviewTaskResult {
  readonly review: TaskReview;
  readonly packet: ReviewPacket;
}

/**
 * `forge task review`: builds a bounded evidence packet for the task's
 * latest attempt, asks the reviewer ONCE (read-only, verified), and records
 * the review — including unavailable/invalid outcomes — as advisory
 * evidence. Never changes task status, reruns anything, or repairs anything.
 *
 * Rule: only an attempt that passed deterministic validation (`validated`)
 * is reviewed. Failed validation already says the work is not acceptable.
 */
export async function reviewTask(options: ReviewTaskOptions): Promise<ReviewTaskResult> {
  const clock = options.clock ?? (() => new Date());
  const generateId = options.generateId ?? randomUUID;
  const store = options.store ?? openStateStore(options.project);

  const state = await store.load();
  const taskId = resolveTaskReference(state, options.task);
  const task = state.tasks.find((candidate) => candidate.id === taskId)!;
  const attempt = task.attempts.at(-1);
  if (task.status !== 'succeeded' || attempt === undefined || attempt.outcome !== 'validated' || attempt.changes === null) {
    throw new WorkflowError(
      `Task "${task.title}" cannot be reviewed: only a task whose latest attempt passed deterministic validation (with recorded changes) is reviewed`,
    );
  }

  const git = await GitClient.create({ runner: options.runner, root: options.project.layout.root });
  const profile = await new ValidationProfileStore(options.project.layout).load();
  const packet = await buildReviewPacket({ git, state, task, attempt, profile, limits: options.limits ?? DEFAULT_REVIEW_LIMITS });

  const requestId = generateId();
  const response = await runReadOnly(options.project, options.runner, () =>
    options.provider.complete(
      buildReviewerRequest({ requestId, packet: packet.text, timeoutMs: options.timeoutMs }),
      options.signal === undefined ? {} : { signal: options.signal },
    ),
  );
  const parsed = parseReviewResponse(response);

  const review: TaskReview = parsed.ok
    ? {
        id: requestId,
        taskId,
        attempt: attempt.number,
        status: deriveReviewStatus(parsed.review.findings),
        recommendation: parsed.review.recommendation,
        confidence: parsed.review.confidence,
        summary: parsed.review.summary,
        findings: parsed.review.findings,
        call: response.call,
        context: packet.summary,
        diagnostic: null,
        createdAt: clock().toISOString(),
        decision: null,
      }
    : {
        id: requestId,
        taskId,
        attempt: attempt.number,
        status: response.outcome === 'success' ? 'invalid-output' : response.outcome,
        recommendation: null,
        confidence: null,
        summary: null,
        findings: [],
        call: response.call,
        context: packet.summary,
        diagnostic: parsed.diagnostic.slice(0, AI_LIMITS.diagnostic),
        createdAt: clock().toISOString(),
        decision: null,
      };

  await store.update((current) => recordReview(current, review));
  return { review, packet };
}
