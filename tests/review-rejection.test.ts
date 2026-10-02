import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { currentFingerprint, resolveApproval } from '../src/approvals/index.ts';
import { explain } from '../src/control/explain.ts';
import { buildPolicy, decideNext, describeStop } from '../src/orchestration/index.ts';
import type { PolicyOptions } from '../src/orchestration/index.ts';
import { openStateStore } from '../src/projects/index.ts';
import { decideReview } from '../src/review/index.ts';
import { APPROVAL_LIMITS, AI_LIMITS } from '../src/state/index.ts';
import type { ApprovalRecord, ProjectState, StateStore } from '../src/state/index.ts';
import { deriveWorkflow, repairsUsed } from '../src/tasks/index.ts';
import { FakeAiProvider } from './ai-fixtures.ts';
import { TempDirs } from './fixtures.ts';
import { git } from './git-fixtures.ts';
import { DIVIDE, MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, scriptedReviewer, scriptedWorker } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';

/**
 * A human REJECTING Forge's review-acceptance request means "not accepted;
 * revise it": it becomes the human's remediation decision and the task is
 * repaired. Modelled on the real TaskFlow 2.4 state: attempt 2 (a repair)
 * validated, review concerns, the AI said accept with medium confidence,
 * Forge overruled it and asked a human, and the human rejected with an
 * actionable reason — after which `forge run` used to strand the task.
 */

const temp = new TempDirs();
after(() => temp.cleanup());

const REASON =
  'Resolve the remaining clock-dependent validation concern before acceptance. Verify whether validateTaskInput has any time-based dueDate rule. Existing overdue tasks must remain editable, completable, and unassignable when dueDate itself is unchanged. Add regression tests covering edit, completion, and project unassignment of an overdue task.';
const CONCERN = reviewJson([{ severity: 'warning', title: 'Clock-dependent validation', remediation: 'Do not re-validate unchanged dueDate' }]);
const WITH_TESTS = { 'src/math.js': MULTIPLY, 'test/math.test.js': 'first tests\n' };
const REPAIRED = { 'src/math.js': `${MULTIPLY}// dueDate unchanged: not re-validated\n`, 'test/math.test.js': 'overdue edit/complete/unassign tests\n' };

function decisionJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    reason: 'Evidence supports it.',
    findingAssessments: [],
    requirementAssessments: [],
    requiredActions: [],
    humanReason: null,
    ...fields,
  });
}

/** A decision-maker that reads what it must assess from the packet and answers with `verdict`. */
function decider(verdicts: readonly ('reject' | 'accept-medium' | 'accept-high')[]): FakeAiProvider {
  let calls = 0;
  return new FakeAiProvider(async (request) => {
    const verdict = verdicts[Math.min(calls, verdicts.length - 1)]!;
    calls += 1;
    const labels = (/outstanding requirements: ([^\n]*)/.exec(request.input)![1]!.match(/R\d+/g) ?? []) as string[];
    const findings = (/reviewer findings to assess: ([^;]*);/.exec(request.input)![1]!.match(/\d+/g) ?? []).map(Number);
    const assess = {
      findingAssessments: findings.map((finding) => ({ finding, status: verdict === 'reject' ? 'unresolved' : 'acceptable', note: 'n' })),
      requirementAssessments: labels.map((requirement) => ({ requirement, status: 'satisfied', evidence: 'test file changed' })),
    };
    if (verdict === 'reject') {
      return { text: decisionJson({ ...assess, decision: 'reject', confidence: 'medium', requiredActions: ['Add tests for overdue tasks'] }) };
    }
    return { text: decisionJson({ ...assess, confidence: verdict === 'accept-high' ? 'high' : 'medium' }) };
  }, 'fake-decider', 'Fake Decider');
}

const AUTO: PolicyOptions = { review: true, reviewer: 'fake-reviewer', autoDecide: true, decisionMaker: 'fake-decider', repairOnBlockingReview: true, maxRepairsPerTask: 3, autoCommit: true };

/**
 * TaskFlow 2.4: task 1.1 (attempt 1 rejected by the AI, attempt 2 a validated repair with review
 * concerns, AI accept/medium overruled by Forge) has a review-acceptance request the human REJECTED.
 * Task 1.2 does not depend on it, so it is otherwise runnable (like TaskFlow 2.5).
 */
async function rejectedReviewAcceptance(options: { readonly maxAttempts?: number; readonly reason?: string } = {}) {
  const setup = await orchestrationProject(temp, { tasks: false });
  await setup.engine.addMilestone({ title: 'Math' });
  await setup.engine.addTask({ milestone: '1', title: 'Add multiply', instruction: 'Add multiply(a, b)', ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }) });
  await setup.engine.addTask({ milestone: '1', title: 'Add divide', instruction: 'Add divide(a, b)' });
  const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, WITH_TESTS, REPAIRED, { 'src/math.js': `${DIVIDE}// dueDate unchanged: not re-validated\n` }]);
  const reviewer = scriptedReviewer([CONCERN, CONCERN, reviewJson([]), reviewJson([])]);
  const ai = decider(['reject', 'accept-medium', 'accept-high']);
  const run = (policy: PolicyOptions = AUTO, mode: 'run' | 'step' = 'run') => makeOrchestrator(setup, worker, policy, { reviewer, decisionMaker: ai }).run(mode);

  const first = await run();
  assert.equal(first.stop.reason, 'decision-overruled');
  const state = await setup.store.load();
  const approval = state.approvals.find((candidate) => candidate.status === 'pending')!;
  assert.equal(approval.type, 'review-acceptance');
  await setup.store.update((current) => resolveApproval(current, approval.id, 'rejected', options.reason ?? REASON, new Date(), currentFingerprint(current, approval)).state);
  const commits = await commitCount(setup.root);
  return { setup, worker, reviewer, ai, run, approvalId: approval.id, commits, taskId: state.tasks[0]!.id, reviewId: state.taskReviews.at(-1)!.id };
}

async function commitCount(root: string): Promise<number> {
  return Number((await git(root, 'rev-list', '--count', 'HEAD')).trim());
}

const steps = (result: { steps: readonly { action: string; outcome: string; taskKey: string | null }[] }) => result.steps.map((step) => `${step.action}:${step.outcome}:${step.taskKey ?? '-'}`);
const approvalOf = (state: ProjectState, id: string): ApprovalRecord => state.approvals.find((candidate) => candidate.id === id)!;
const policyOf = (options: PolicyOptions) => buildPolicy({ access: 'edit', worker: 'fake-worker', ...options }, { workerTimeoutMs: 60_000 });

describe('rejected review-acceptance approval -> human remediation', () => {
  it('A/C/K: converts to a human remediation decision and reopens the task, keeping every record', async () => {
    const { setup, run, approvalId, taskId, reviewId, commits } = await rejectedReviewAcceptance();
    const before = await setup.store.load();
    const validation = before.tasks[0]!.attempts[1]!.validation;
    const aiDecisions = before.aiDecisions;

    const result = await run(AUTO, 'step');
    assert.deepEqual(steps(result), ['apply-approval:remediation-required:1.1']);
    assert.match(result.steps[0]!.detail ?? '', /Human rejected review acceptance through approval .{8}\. Reason: Resolve the remaining clock-dependent/);
    assert.notEqual(result.stop.reason, 'approval-rejected');

    const state = await setup.store.load();
    const task = state.tasks[0]!;
    assert.deepEqual([task.status, task.attempts.length, task.attempts[1]!.outcome], ['failed', 2, 'review-rejected']);
    assert.deepEqual(task.attempts[1]!.validation, validation, 'deterministic validation evidence is kept');
    assert.equal(task.attempts[1]!.commit, null);
    const review = state.taskReviews.find((candidate) => candidate.id === reviewId)!;
    assert.deepEqual(
      [review.attempt, review.decision?.kind, review.decision?.by, review.decision?.approvalId, review.decision?.aiDecisionId],
      [2, 'remediation-required', 'human', approvalId, null],
    );
    const remediation = state.remediations.find((candidate) => candidate.reviewId === reviewId)!;
    assert.deepEqual(
      [remediation.taskId, remediation.source, remediation.fromAttempt, remediation.status, remediation.requirements],
      [taskId, 'human', 2, 'open', [REASON]],
      'provenance: human, the review and attempt the approval was bound to, the reason verbatim',
    );
    assert.deepEqual(state.aiDecisions, aiDecisions, 'AI decision history untouched');
    const approval = approvalOf(state, approvalId);
    assert.deepEqual([approval.status, approval.resolution?.decision, approval.consumedAt], ['rejected', 'rejected', null], 'the approval stays REJECTED');
    assert.equal(state.tasks[1]!.attempts.length, 0, '1.2 not started');
    assert.equal(await commitCount(setup.root), commits);
    assert.equal(repairsUsed(task), 1, 'converting consumes no repair');

    const next = decideNext(state, deriveWorkflow(state), policyOf(AUTO), { runId: 'x', tasksStarted: new Set(), reviewsThisRun: new Set() });
    assert.deepEqual([next.kind, 'taskId' in next ? next.taskId : null], ['repair', taskId], 'next: repair 1.1, not 1.2');
  });

  it('B: a maximum-length reason is the requirement verbatim; the decision reason stays within the state bound', async () => {
    const reason = `${'Fix the overdue edit path. '.repeat(40)}`.slice(0, APPROVAL_LIMITS.reason).trim();
    const { setup, run, reviewId } = await rejectedReviewAcceptance({ reason });
    await run(AUTO, 'step');
    const state = await setup.store.load();
    assert.deepEqual(state.remediations.find((candidate) => candidate.reviewId === reviewId)!.requirements, [reason]);
    const decision = state.taskReviews.find((candidate) => candidate.id === reviewId)!.decision!;
    assert.ok(decision.reason.length <= AI_LIMITS.reason);
    assert.match(decision.reason, /^Rejected by a human through approval .{8}: Fix the overdue/);
    // And the state survives a reload (strict decoding + invariants).
    assert.deepEqual(await openStateStore(setup.project).load(), state);
  });

  it('D/J/M: repairs with the human reason, re-validates, re-reviews, re-decides, commits, and only then runs 1.2', async () => {
    const { setup, run, worker, ai, approvalId, reviewId, commits } = await rejectedReviewAcceptance();
    const result = await run();
    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result), [
      'apply-approval:remediation-required:1.1',
      'repair:validated:1.1',
      'review:clear:1.1',
      'decide:ai-accepted:1.1',
      'commit:committed:1.1',
      'execute:validated:1.2',
      'review:clear:1.2',
      'commit:committed:1.2',
      'complete-milestone:completed:-',
    ]);
    assert.ok((worker.requests[2]!.repairEvidence ?? '').includes(REASON), 'the repair receives the human reason');
    assert.ok(ai.requests[2]!.input.includes(REASON), 'the decision-maker must assess the human requirement');

    const state = await setup.store.load();
    const task = state.tasks[0]!;
    assert.deepEqual(task.attempts.map((attempt) => attempt.outcome), ['review-rejected', 'review-rejected', 'validated']);
    assert.equal(task.attempts[2]!.validation?.status, 'passed', 'new deterministic validation');
    assert.equal(task.attempts[1]!.commit, null, 'the rejected attempt was never committed');
    assert.ok(task.attempts[2]!.commit !== null);
    // The old AI acceptance (medium) stays escalated on the rejected review; acceptance came only from new evidence.
    const old = state.aiDecisions.find((decision) => decision.reviewId === reviewId)!;
    assert.deepEqual([old.verdict, old.effect], ['accept', 'escalated']);
    const accepted = state.aiDecisions.find((decision) => decision.effect === 'accepted')!;
    const newReview = state.taskReviews.find((review) => review.id === accepted.reviewId)!;
    assert.deepEqual([accepted.attempt, newReview.attempt, newReview.decision?.kind], [3, 3, 'accepted']);
    assert.deepEqual(state.remediations.map((remediation) => [remediation.source, remediation.status]), [['ai', 'satisfied'], ['human', 'satisfied']]);
    assert.equal(approvalOf(state, approvalId).status, 'rejected', 'still REJECTED in history');
    assert.equal(await commitCount(setup.root), commits + 2);
  });

  it('E: repeated runs process the rejection exactly once (no duplicate remediation, transition, repair or approval)', async () => {
    const { setup, run, reviewId } = await rejectedReviewAcceptance();
    const approvalsBefore = (await setup.store.load()).approvals.length;
    await run(AUTO, 'step');
    const second = await run(AUTO, 'step');
    assert.deepEqual(steps(second), ['repair:validated:1.1'], 'the second run repairs; it does not convert again');
    const state = await setup.store.load();
    assert.equal(state.remediations.filter((remediation) => remediation.reviewId === reviewId).length, 1);
    assert.equal(state.taskReviews.filter((review) => review.decision?.approvalId !== null && review.decision !== null).length, 1);
    assert.equal(repairsUsed(state.tasks[0]!), 2, 'exactly one new repair');
    assert.equal(state.approvals.length, approvalsBefore, 'no new approval');
  });

  it('F: crash/restart safe: a write that never happened is redone once; one that happened is never repeated', async () => {
    const { setup, worker, reviewer, ai, run, reviewId, approvalId } = await rejectedReviewAcceptance();
    // A process that dies while applying it: the atomic write never lands.
    let failNext = true;
    const crashing: StateStore = {
      ...setup.store,
      load: () => setup.store.load(),
      update: (mutate) => {
        if (failNext) {
          return setup.store.update((current) => {
            const next = mutate(current);
            if (next.taskReviews.some((review) => review.id === reviewId && review.decision !== null)) {
              failNext = false;
              throw new Error('simulated crash during the write');
            }
            return next;
          });
        }
        return setup.store.update(mutate);
      },
    } as StateStore;
    const crashed = await makeOrchestrator({ ...setup, store: crashing }, worker, AUTO, { reviewer, decisionMaker: ai }).run('step');
    assert.equal(crashed.stop.reason, 'error');
    assert.match(crashed.stop.detail ?? '', /simulated crash/);
    let state = await openStateStore(setup.project).load();
    assert.equal(state.taskReviews.find((review) => review.id === reviewId)!.decision, null, 'nothing half-applied');
    assert.equal(approvalOf(state, approvalId).status, 'rejected');

    // Restart (fresh store): converted once; a further restart continues with the repair.
    await run(AUTO, 'step');
    const reopened = openStateStore(setup.project);
    state = await reopened.load();
    assert.equal(state.remediations.filter((remediation) => remediation.reviewId === reviewId).length, 1);
    const next = await makeOrchestrator({ ...setup, store: reopened }, worker, AUTO, { reviewer, decisionMaker: ai }).run('step');
    assert.deepEqual(steps(next), ['repair:validated:1.1']);
  });

  it('L: the rejected approval can never later be approved (or rejected again)', async () => {
    const { setup, run, approvalId } = await rejectedReviewAcceptance();
    for (const moment of ['before conversion', 'after conversion']) {
      const state = await setup.store.load();
      const approval = approvalOf(state, approvalId);
      assert.throws(() => resolveApproval(state, approvalId, 'approved', 'changed my mind', new Date(), currentFingerprint(state, approval)), /is rejected; only a pending approval/, moment);
      await run(AUTO, 'step');
    }
  });

  it('explain says what will happen instead of a generic APPROVAL REJECTED', async () => {
    const { setup } = await rejectedReviewAcceptance();
    const state = await setup.store.load();
    const text = explain({ state, view: deriveWorkflow(state), policy: policyOf(AUTO) }).join('\n');
    assert.match(text, /A human rejected review acceptance for task 1\.1 \(approval .{8}\)\./);
    assert.match(text, /Reason: Resolve the remaining clock-dependent/);
    assert.match(text, /reopen the task for remediation, and then repair it/);
    assert.doesNotMatch(text, /A run would stop: APPROVAL REJECTED/);
  });
});

describe('rejected review-acceptance approval: unsafe cases stop and name the blocker (no reopen)', () => {
  async function assertBlocked(setup: OrchestrationSetup, approvalId: string, reviewId: string, result: { stop: { reason: string; detail: string | null } }, blocker: RegExp) {
    assert.equal(result.stop.reason, 'review-rejection-blocked');
    assert.match(result.stop.detail ?? '', /A human rejected review acceptance of task 1\.1/);
    assert.match(result.stop.detail ?? '', blocker);
    assert.equal(describeStop('review-rejection-blocked').category, 'human');
    const state = await setup.store.load();
    assert.equal(state.tasks[0]!.status, 'succeeded', 'not reopened');
    assert.equal(state.taskReviews.find((review) => review.id === reviewId)!.decision, null);
    assert.equal(state.remediations.filter((remediation) => remediation.reviewId === reviewId).length, 0);
    assert.equal(approvalOf(state, approvalId).status, 'rejected');
    assert.equal(state.tasks[1]!.attempts.length, 0, '1.2 not started');
  }

  it('G: repair budget exhausted', async () => {
    const { setup, run, approvalId, reviewId, commits } = await rejectedReviewAcceptance();
    const result = await run({ ...AUTO, maxRepairsPerTask: 1 });
    await assertBlocked(setup, approvalId, reviewId, result, /repair budget is used up \(1\/1: 0 validation, 1 review\)/);
    assert.equal(await commitCount(setup.root), commits, 'the rejected work is not committed either');
  });

  it('H: attempt budget exhausted', async () => {
    const { setup, run, approvalId, reviewId } = await rejectedReviewAcceptance({ maxAttempts: 2 });
    await assertBlocked(setup, approvalId, reviewId, await run(), /all 2 attempts have been used/);
  });

  it('I: dependent work already ran on top of the task', async () => {
    const { setup, run, approvalId, reviewId } = await rejectedReviewAcceptance();
    await setup.engine.addTask({ milestone: '1', title: 'Use multiply', instruction: 'Use multiply', dependsOn: ['1.1'] });
    await setup.engine.runTask('1.3', { worker: scriptedWorker(setup.root, [{ 'src/use.js': 'use\n' }]), access: 'edit', timeoutMs: 60_000 });
    await assertBlocked(setup, approvalId, reviewId, await run(), /dependent tasks already ran on top of it/);
  });
});

describe('other approval types: a rejection still means STOP', () => {
  it('N: a rejected task-retry approval stops without running anything', async () => {
    const setup = await orchestrationProject(temp);
    const { BROKEN_MULTIPLY } = await import('./orchestration-fixtures.ts');
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': BROKEN_MULTIPLY }, { 'src/math.js': MULTIPLY }]);
    assert.equal((await makeOrchestrator(setup, worker).run()).stop.reason, 'repair-not-permitted');
    const approval = (await setup.store.load()).approvals[0]!;
    assert.equal(approval.type, 'task-retry');
    await setup.store.update((state) => resolveApproval(state, approval.id, 'rejected', 'Do not retry this', new Date(), approval.fingerprint).state);
    const result = await makeOrchestrator(setup, worker).run();
    assert.equal(result.stop.reason, 'approval-rejected');
    assert.equal(worker.requests.length, 1);
    const state = await setup.store.load();
    assert.deepEqual(state.remediations, []);
    assert.equal(state.approvals[0]!.status, 'rejected');
  });

  it('O: `forge task review-reject` (a direct human decision) is unchanged and records no approval', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const reviewer = scriptedReviewer([CONCERN]);
    await makeOrchestrator(setup, worker, { review: true, reviewer: reviewer.id }, { reviewer }).run();
    const taskId = (await setup.store.load()).tasks[0]!.id;
    const state = await setup.store.update((current) => decideReview(current, taskId, 'remediation-required', 'Add tests', new Date()));
    assert.deepEqual([state.taskReviews[0]!.decision?.by, state.taskReviews[0]!.decision?.approvalId, state.remediations[0]!.requirements], ['human', null, ['Add tests']]);
    assert.equal(state.tasks[0]!.status, 'failed');
    assert.throws(() => decideReview(state, taskId, 'accepted', 'x', new Date(), 'policy', { approvalId: 'abc' }), /Only a human decision can come through an approval/);
  });
});

describe('schema 10: review decisions record the approval they came through', () => {
  async function rawState(setup: OrchestrationSetup): Promise<Record<string, unknown>> {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(setup.project.layout.stateFile, 'utf8')) as Record<string, unknown>;
  }
  async function writeState(setup: OrchestrationSetup, doc: Record<string, unknown>): Promise<void> {
    const { write } = await import('./git-fixtures.ts');
    await write(setup.root, '.forge/state.json', `${JSON.stringify(doc, null, 2)}\n`);
  }

  it('migrates version 9 decisions with approvalId null, and refuses a version 9 document that already has it', async () => {
    const { setup, run } = await rejectedReviewAcceptance();
    await run(AUTO, 'step');
    const doc = await rawState(setup);
    const reviews = doc['taskReviews'] as Record<string, Record<string, unknown> | null>[];
    // A version 9 document as the previous Forge wrote it (no approval links).
    const runs = doc['orchestrationRuns'] as Record<string, Record<string, unknown>>[];
    const v9 = {
      ...doc,
      schemaVersion: 9,
      // As the version 9 Forge wrote it: no approval links (v10), no evidence rounds or recovery policy/counters (v11).
      taskReviews: reviews.map((review) => {
        const { evidenceRound: _round, ...rest } = review as Record<string, unknown>;
        return rest['decision'] === null ? rest : { ...rest, decision: { ...(rest['decision'] as object), approvalId: undefined } };
      }),
      orchestrationRuns: runs.map((run) => {
        const { autonomous: _autonomous, recovery: _recovery, ...policy } = run['policy']!;
        const { timeoutRecoveries: _t, providerRetries: _p, evidenceReviews: _e, humanInterventions: _h, ...counters } = run['counters']!;
        return { ...run, policy, counters };
      }),
    };
    await writeState(setup, JSON.parse(JSON.stringify(v9)) as Record<string, unknown>);
    const migrated = await openStateStore(setup.project).load();
    assert.equal(migrated.schemaVersion, 11, 'migrated through version 10 to the current version');
    assert.ok(migrated.taskReviews.every((review) => review.decision === null || review.decision.approvalId === null));

    await writeState(setup, { ...doc, schemaVersion: 9 });
    await assert.rejects(openStateStore(setup.project).load(), /is not a schema version 9 review decision/);
  });

  it('refuses an approval link that does not match a rejected/used review-acceptance request of the task, or a non-human decision', async () => {
    const { setup, run, reviewId } = await rejectedReviewAcceptance();
    await run(AUTO, 'step');
    const doc = await rawState(setup);
    const approvals = doc['approvals'] as Record<string, unknown>[];
    const pending = approvals.map((approval) => ({ ...approval, status: 'pending', resolution: null }));
    await writeState(setup, { ...doc, approvals: pending });
    await assert.rejects(openStateStore(setup.project).load(), /approvalId must reference this task's review-acceptance approval, rejected by a human/);

    const reviews = (doc['taskReviews'] as Record<string, unknown>[]).map((review) =>
      review['id'] === reviewId ? { ...review, decision: { ...(review['decision'] as object), by: 'policy' } } : review,
    );
    await writeState(setup, { ...doc, taskReviews: reviews });
    await assert.rejects(openStateStore(setup.project).load(), /approvalId can only be set for a human decision/);
  });
});
