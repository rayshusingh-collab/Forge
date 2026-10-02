import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { currentFingerprint, resolveApproval, taskApprovalBinding } from '../src/approvals/index.ts';
import type { AiResponse } from '../src/ai/index.ts';
import { DECISION_MAKER_INSTRUCTIONS, DECISION_OUTPUT_LIMITS, parseDecisionResponse } from '../src/decision/index.ts';
import { describeStop } from '../src/orchestration/index.ts';
import { decideReview } from '../src/review/index.ts';
import type { ApprovalRecord, ProjectState, StopReason } from '../src/state/index.ts';
import { repairsUsed } from '../src/tasks/index.ts';
import { FakeAiProvider } from './ai-fixtures.ts';
import { TempDirs } from './fixtures.ts';
import { git } from './git-fixtures.ts';
import { DIVIDE, MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, scriptedReviewer, scriptedWorker } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';

/**
 * The decision-maker output contract, modelled on the real TaskFlow 2.1
 * failure: after a validated repair and a CLEAR review, the decision-maker
 * answered with valid JSON whose `requirementAssessments[1].evidence` was
 * longer than the 500-character bound it had never been told about. Forge
 * failed closed (correct) but reported it as the provider being unavailable.
 *
 * The bounds stay strict; the instructions now state every one of them, an
 * invalid answer is classified as such, and the run can resume safely.
 */

const temp = new TempDirs();
after(() => temp.cleanup());

const TESTS_REQUIRED = 'Add deterministic tests for multiply in test/math.test.js covering negative numbers';
const CONCERN = reviewJson([{ severity: 'warning', title: 'No tests for multiply', remediation: 'Add tests' }]);
const EVIDENCE_MAX = DECISION_OUTPUT_LIMITS.requirementEvidence;

function decisionJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    reason: 'test/math.test.js was added and the required check passed.',
    findingAssessments: [],
    requirementAssessments: [],
    requiredActions: [],
    humanReason: null,
    ...fields,
  });
}

/** An acceptance of R1 whose evidence has exactly `length` characters. */
const acceptR1 = (length: number) => decisionJson({ requirementAssessments: [{ requirement: 'R1', status: 'satisfied', evidence: 'e'.repeat(length) }] });
const OVERSIZED = acceptR1(EVIDENCE_MAX + 1);
const VALID = acceptR1(120);

type Answer = string | { outcome: 'unavailable' | 'timeout' | 'failed' };

/** A decision-maker whose Nth answer is `answers[N]` (the last repeats). */
function scriptedDecider(answers: readonly Answer[]): FakeAiProvider {
  let calls = 0;
  return new FakeAiProvider(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return typeof answer === 'string' ? { text: answer } : { outcome: answer.outcome, text: null, diagnostic: `decision-maker ${answer.outcome}` };
  }, 'fake-decider', 'Fake Decider');
}

/** A decision-maker that answers from a queue the test can change between runs. */
function queuedDecider(): { provider: FakeAiProvider; next: Answer[] } {
  const next: Answer[] = [];
  const provider = new FakeAiProvider(async () => {
    const answer = next.length > 1 ? next.shift()! : next[0]!;
    return typeof answer === 'string' ? { text: answer } : { outcome: answer.outcome, text: null, diagnostic: `decision-maker ${answer.outcome}` };
  }, 'fake-decider', 'Fake Decider');
  return { provider, next };
}

function response(text: string): AiResponse {
  return { outcome: 'success', text, call: { provider: 'x', model: null, durationMs: 1, costUsd: null, inputTokens: null, outputTokens: null }, diagnostic: null };
}

async function commitCount(root: string): Promise<number> {
  return Number((await git(root, 'rev-list', '--count', 'HEAD')).trim());
}

const steps = (result: { steps: readonly { action: string; outcome: string }[] }) => result.steps.map((step) => `${step.action}:${step.outcome}`);

/**
 * The TaskFlow 2.1 shape: task 1.1 got review concerns, a human required
 * remediation, an orchestrated repair passed validation and got a CLEAR
 * review, and the decision-maker (asked because human remediation is open)
 * returned oversized evidence. Returns the state at that point.
 */
async function taskFlowAfterInvalidDecision(first: Answer = OVERSIZED) {
  const setup = await orchestrationProject(temp);
  const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': MULTIPLY, 'test/math.test.js': 'ok\n' }, { 'src/math.js': DIVIDE }]);
  const reviewer = scriptedReviewer([CONCERN, reviewJson([]), reviewJson([])]);
  await makeOrchestrator(setup, worker, { review: true, reviewer: reviewer.id }, { reviewer }).run();
  const taskId = (await setup.store.load()).tasks[0]!.id;
  await setup.store.update((state) => decideReview(state, taskId, 'remediation-required', TESTS_REQUIRED, new Date()));

  const decider = queuedDecider();
  decider.next.push(first);
  const options = {
    review: true,
    reviewer: reviewer.id,
    autoDecide: true,
    decisionMaker: decider.provider.id,
    repairOnBlockingReview: true,
    maxRepairsPerTask: 3,
    autoCommit: true,
  };
  const run = () => makeOrchestrator(setup, worker, options, { reviewer, decisionMaker: decider.provider }).run();
  const commitsBefore = await commitCount(setup.root);
  const result = await run();
  return { setup, taskId, decider, run, result, commitsBefore, worker };
}

function pendingApproval(state: ProjectState): ApprovalRecord {
  const pending = state.approvals.filter((approval) => approval.status === 'pending');
  assert.equal(pending.length, 1, 'exactly one pending approval');
  return pending[0]!;
}

async function resolve(setup: OrchestrationSetup, approvalId: string, decision: 'approved' | 'rejected', reason: string) {
  let outcome = '';
  await setup.store.update((state) => {
    const approval = state.approvals.find((candidate) => candidate.id === approvalId)!;
    const resolved = resolveApproval(state, approvalId, decision, reason, new Date(), currentFingerprint(state, approval));
    outcome = resolved.kind;
    return resolved.state;
  });
  return outcome;
}

describe('decision contract: the instructions state every bound the decoder enforces', () => {
  it('B: tells the provider the evidence maximum, to stay concise, and never to quote diffs or output', () => {
    assert.equal(EVIDENCE_MAX, 500);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /each "evidence" at most 500 characters/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /"evidence": string \(at most 500 characters\)/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /concise factual evidence only/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /SUMMARIZE the evidence; do NOT reproduce it/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /never quote diffs, file contents, test or check output/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /HARD limits/);
    assert.match(DECISION_MAKER_INSTRUCTIONS, /rejected as invalid \(nothing is truncated/);
  });

  it('B: every limit in the shared table appears in the instructions next to its field', () => {
    const L = DECISION_OUTPUT_LIMITS;
    const expectations: [string, RegExp][] = [
      ['reason', new RegExp(`"reason": 1 to ${L.reason} characters`)],
      ['humanReason', new RegExp(`"humanReason": 1 to ${L.humanReason} characters`)],
      ['findingAssessments', new RegExp(`"findingAssessments": at most ${L.findingAssessments} items`)],
      ['findingNote', new RegExp(`each "note" at most ${L.findingNote} characters`)],
      ['requirementAssessments', new RegExp(`"requirementAssessments": at most ${L.requirementAssessments} items`)],
      ['requirementEvidence', new RegExp(`each "evidence" at most ${L.requirementEvidence} characters`)],
      ['requiredActions', new RegExp(`"requiredActions": at most ${L.requiredActions} items`)],
      ['requiredAction', new RegExp(`each 1 to ${L.requiredAction} characters`)],
      ['answer', new RegExp(`whole answer: at most ${L.answer} characters`)],
    ];
    assert.deepEqual(expectations.map(([key]) => key).sort(), Object.keys(L).sort(), 'no limit in the table is left unchecked');
    for (const [key, pattern] of expectations) {
      assert.match(DECISION_MAKER_INSTRUCTIONS, pattern, key);
    }
  });
});

describe('decision contract: strict decoding at the stated bounds', () => {
  const expected = { findingsToAssess: [1], findingCount: 1, requirementLabels: ['R1', 'R2'] };
  const ok = {
    findingAssessments: [{ finding: 1, status: 'resolved', note: 'fixed in src/math.js' }],
    requirementAssessments: [
      { requirement: 'R1', status: 'satisfied', evidence: 'test/math.test.js added' },
      { requirement: 'R2', status: 'satisfied', evidence: 'check unit-tests passed' },
    ],
  };

  it('A: valid JSON with 501-character evidence is rejected with the exact diagnostic; 500 is accepted', () => {
    const at = (length: number) =>
      decisionJson({ ...ok, requirementAssessments: [ok.requirementAssessments[0], { ...ok.requirementAssessments[1], evidence: 'x'.repeat(length) }] });
    const over = parseDecisionResponse(response(at(EVIDENCE_MAX + 1)), expected);
    assert.equal(over.ok, false);
    assert.equal(!over.ok && over.diagnostic, 'invalid decision: requirementAssessments[1].evidence must be at most 500 characters');
    const parsed = parseDecisionResponse(response(at(EVIDENCE_MAX)), expected);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.ok && parsed.decision.requirementAssessments[1]!.evidence.length, EVIDENCE_MAX, 'never truncated');
  });

  it('D: every other bounded field is still rejected one past its bound (nothing truncated)', () => {
    const L = DECISION_OUTPUT_LIMITS;
    const escalate = { ...ok, decision: 'escalate', humanReason: 'h' };
    const reject = { ...ok, decision: 'reject', requiredActions: ['a'] };
    const cases: [string, string][] = [
      ['reason', decisionJson({ ...ok, reason: 'r'.repeat(L.reason + 1) })],
      ['humanReason', decisionJson({ ...escalate, humanReason: 'h'.repeat(L.humanReason + 1) })],
      ['finding note', decisionJson({ ...ok, findingAssessments: [{ ...ok.findingAssessments[0], note: 'n'.repeat(L.findingNote + 1) }] })],
      ['first evidence', decisionJson({ ...ok, requirementAssessments: [{ ...ok.requirementAssessments[0], evidence: 'e'.repeat(L.requirementEvidence + 1) }, ok.requirementAssessments[1]] })],
      ['required action length', decisionJson({ ...reject, requiredActions: ['a'.repeat(L.requiredAction + 1)] })],
      ['required action count', decisionJson({ ...reject, requiredActions: Array.from({ length: L.requiredActions + 1 }, (_, index) => `action ${index}`) })],
      ['finding assessment count', decisionJson({ ...ok, findingAssessments: Array.from({ length: L.findingAssessments + 1 }, () => ok.findingAssessments[0]) })],
      [
        'requirement assessment count',
        decisionJson({ ...ok, requirementAssessments: Array.from({ length: L.requirementAssessments + 1 }, () => ok.requirementAssessments[0]) }),
      ],
      ['requirement label shape', decisionJson({ ...ok, requirementAssessments: [ok.requirementAssessments[0], { ...ok.requirementAssessments[1], requirement: 'R02' }] })],
      ['whole answer', `${decisionJson(ok)}${' '.repeat(L.answer)}`],
    ];
    for (const [label, text] of cases) {
      const parsed = parseDecisionResponse(response(text), expected);
      assert.equal(parsed.ok, false, label);
    }
    // At their bounds, the same fields are accepted: the limits are exactly the stated ones.
    const atBounds = [
      decisionJson({ ...ok, reason: 'r'.repeat(L.reason) }),
      decisionJson({ ...escalate, humanReason: 'h'.repeat(L.humanReason) }),
      decisionJson({ ...ok, findingAssessments: [{ ...ok.findingAssessments[0], note: 'n'.repeat(L.findingNote) }] }),
      decisionJson({ ...reject, requiredActions: Array.from({ length: L.requiredActions }, () => 'a'.repeat(L.requiredAction)) }),
    ];
    for (const text of atBounds) {
      assert.equal(parseDecisionResponse(response(text), expected).ok, true);
    }
  });

  it('C: a provider that follows the documented bound produces an answer that parses and is accepted', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]);
    const reviewer = scriptedReviewer([CONCERN, reviewJson([])]);
    // Reads the limit from the instructions it was given — not from Forge's code — and writes up to it.
    const decider = new FakeAiProvider(async (request) => {
      const limit = Number(/each "evidence" at most (\d+) characters/.exec(request.instructions)?.[1]);
      const note = Number(/each "note" at most (\d+) characters/.exec(request.instructions)?.[1]);
      return { text: decisionJson({ findingAssessments: [{ finding: 1, status: 'acceptable', note: 'n'.repeat(note) }], reason: `evidence limit ${limit}` }) };
    }, 'fake-decider');
    const result = await makeOrchestrator(
      setup,
      worker,
      { review: true, reviewer: reviewer.id, autoDecide: true, decisionMaker: decider.id },
      { reviewer, decisionMaker: decider },
    ).run();
    assert.equal(result.stop.reason, 'complete');
    const decision = (await setup.store.load()).aiDecisions[0]!;
    assert.deepEqual([decision.status, decision.effect, decision.reason], ['decided', 'accepted', `evidence limit ${EVIDENCE_MAX}`]);
    assert.equal(decision.findingAssessments[0]!.note.length, DECISION_OUTPUT_LIMITS.findingNote);
  });
});

describe('decision contract: failure classification (all non-accepting)', () => {
  const cases: [string, Answer, StopReason, string][] = [
    ['provider unavailable', { outcome: 'unavailable' }, 'decision-maker-unavailable', 'unavailable'],
    ['provider failed', { outcome: 'failed' }, 'decision-maker-unavailable', 'failed'],
    ['timeout', { outcome: 'timeout' }, 'decision-maker-timeout', 'timeout'],
    ['malformed output', 'Looks fine to me, accept.', 'decision-maker-invalid-output', 'invalid-output'],
    ['oversized evidence', decisionJson({ findingAssessments: [{ finding: 1, status: 'acceptable', note: 'n'.repeat(501) }] }), 'decision-maker-invalid-output', 'invalid-output'],
    ['explicit AI escalation', decisionJson({ decision: 'escalate', confidence: 'high', humanReason: 'A product decision.', findingAssessments: [{ finding: 1, status: 'acceptable', note: '' }] }), 'decision-escalated', 'decided'],
    ['low-confidence acceptance (evidence gate)', decisionJson({ confidence: 'low', findingAssessments: [{ finding: 1, status: 'acceptable', note: '' }] }), 'decision-overruled', 'decided'],
  ];
  for (const [label, answer, reason, status] of cases) {
    it(`E: ${label} stops as ${reason}, never accepts, never commits, never moves on`, async () => {
      const setup = await orchestrationProject(temp);
      const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
      const reviewer = scriptedReviewer([CONCERN]);
      const decider = scriptedDecider([answer]);
      const before = await commitCount(setup.root);
      const result = await makeOrchestrator(
        setup,
        worker,
        { review: true, reviewer: reviewer.id, autoDecide: true, decisionMaker: decider.id, autoCommit: true },
        { reviewer, decisionMaker: decider },
      ).run();
      assert.equal(result.stop.reason, reason);
      assert.equal(describeStop(reason).category, 'human');
      const state = await setup.store.load();
      assert.deepEqual([state.aiDecisions[0]!.status, state.aiDecisions[0]!.effect], [status, 'escalated']);
      assert.equal(state.taskReviews[0]!.decision, null);
      assert.equal(state.tasks[0]!.status, 'succeeded');
      assert.equal(state.tasks[1]!.attempts.length, 0);
      assert.equal(await commitCount(setup.root), before);
      assert.equal(pendingApproval(state).type, 'review-acceptance');
    });
  }

  it('E: each failure kind has its own label; invalid output is not reported as the provider being unavailable', () => {
    const reasons: StopReason[] = ['decision-escalated', 'decision-overruled', 'decision-maker-unavailable', 'decision-maker-invalid-output', 'decision-maker-timeout'];
    const labels = reasons.map((reason) => describeStop(reason).label);
    assert.equal(new Set(labels).size, labels.length);
    assert.match(describeStop('decision-maker-invalid-output').label, /^DECISION-MAKER INVALID OUTPUT/);
    assert.doesNotMatch(describeStop('decision-maker-invalid-output').label, /UNAVAILABLE/);
  });
});

describe('decision contract: resuming the real TaskFlow 2.1 failure', () => {
  it('A/F/I: the oversized answer is rejected; nothing is accepted, committed, repaired, reopened or started', async () => {
    const { setup, decider, result, commitsBefore } = await taskFlowAfterInvalidDecision();
    assert.deepEqual(steps(result), ['repair:validated', 'review:clear', 'decide:ai-escalated']);
    assert.equal(result.stop.reason, 'decision-maker-invalid-output');
    assert.match(result.stop.detail ?? '', /requirementAssessments\[0\]\.evidence must be at most 500 characters/);
    assert.equal(decider.provider.requests.length, 1, 'no immediate retry within the run');

    const state = await setup.store.load();
    const task = state.tasks[0]!;
    assert.deepEqual([task.status, task.attempts.length, task.attempts[1]!.outcome, task.attempts[1]!.validation?.status], ['succeeded', 2, 'validated', 'passed']);
    assert.equal(task.attempts[1]!.commit, null);
    assert.equal(state.taskReviews.at(-1)!.status, 'clear');
    assert.equal(state.taskReviews.at(-1)!.decision, null);
    assert.equal(state.aiDecisions[0]!.status, 'invalid-output');
    assert.deepEqual(state.remediations.map((remediation) => remediation.status), ['open']);
    assert.equal(state.tasks[1]!.attempts.length, 0, 'task 1.2 (the "2.2") did not start');
    assert.equal(await commitCount(setup.root), commitsBefore);
    assert.match(pendingApproval(state).reason, /no usable answer .*invalid-output/);
  });

  it('F: retried only once per later run, bounded per review; retries never touch attempts, validation or the repair budget', async () => {
    const { setup, decider, run } = await taskFlowAfterInvalidDecision();
    const snapshot = (state: ProjectState) => ({ task: state.tasks[0]!, repairs: repairsUsed(state.tasks[0]!), next: state.tasks[1]!.attempts.length });
    const before = snapshot(await setup.store.load());
    for (const expectedRequests of [2, 3, 3, 3]) {
      const again = await run();
      assert.equal(again.stop.reason, 'decision-maker-invalid-output');
      assert.equal(decider.provider.requests.length, expectedRequests);
      assert.deepEqual(snapshot(await setup.store.load()), before, 'task, attempts, validation evidence and repair budget unchanged');
    }
    const state = await setup.store.load();
    assert.equal(state.aiDecisions.length, 3, 'at most 3 decision attempts on one review');
    assert.equal(pendingApproval(state).status, 'pending', 'the human request stays the one to answer');
  });

  it('G: a later run retries, gets a valid decision, safe-commits 1.1, and only then starts 1.2 — without editing state', async () => {
    const { setup, decider, run, commitsBefore } = await taskFlowAfterInvalidDecision();
    const stale = pendingApproval(await setup.store.load());
    decider.next.splice(0, decider.next.length, VALID);
    const result = await run();
    assert.equal(result.stop.reason, 'complete');
    const order = steps(result);
    assert.deepEqual(order.slice(0, 3), ['decide:ai-accepted', 'commit:committed', 'execute:validated']);

    const state = await setup.store.load();
    assert.deepEqual(state.aiDecisions.map((decision) => [decision.status, decision.effect]), [['invalid-output', 'escalated'], ['decided', 'accepted']]);
    assert.equal(state.taskReviews.find((review) => review.taskId === state.tasks[0]!.id && review.attempt === 2)!.decision?.by, 'ai');
    assert.deepEqual(state.remediations.map((remediation) => remediation.status), ['satisfied']);
    assert.ok(state.tasks[0]!.attempts[1]!.commit !== null, '1.1 committed');
    assert.ok(await commitCount(setup.root) >= commitsBefore + 2, '1.1 then 1.2 committed');

    const after = state.approvals.find((approval) => approval.id === stale.id)!;
    assert.equal(after.status, 'invalidated', 'the request made for the invalid answer can no longer be used');
    assert.equal(after.resolution, null, 'it was never resolved on the human\'s behalf');
    assert.equal(after.consumedAt, null, 'nor consumed');
  });

  it('H: a request made for the invalid answer cannot authorize the evidence a later decision produced', async () => {
    const { setup, decider, run } = await taskFlowAfterInvalidDecision();
    const state0 = await setup.store.load();
    const stale = pendingApproval(state0);
    const taskId = state0.tasks[0]!.id;
    const binding = () => taskApprovalBinding(state0, 'review-acceptance', taskId)!.fingerprint;
    assert.equal(stale.fingerprint, binding(), 'still bound to the current evidence before any retry');

    // The retry produces a usable answer that escalates: new evidence for the human.
    decider.next.splice(0, decider.next.length, decisionJson({ decision: 'escalate', humanReason: 'Whether negatives matter is a product call.', requirementAssessments: [{ requirement: 'R1', status: 'unverifiable', evidence: 'test file content not shown' }] }));
    const result = await run();
    assert.equal(result.stop.reason, 'decision-escalated');
    const state = await setup.store.load();
    const old = state.approvals.find((approval) => approval.id === stale.id)!;
    assert.equal(old.status, 'invalidated');
    const fresh = pendingApproval(state);
    assert.notEqual(fresh.id, stale.id);
    assert.ok(fresh.evidence.some((line) => /needs a human because: Whether negatives matter/.test(line)));
    assert.notEqual(fresh.fingerprint, stale.fingerprint);
    await assert.rejects(resolve(setup, stale.id, 'approved', 'ok'), /only a pending approval can be approved/);
    assert.equal(state.taskReviews.at(-1)!.decision, null);
  });

  it('H: approving the old request after a usable decision was recorded (before any sweep) is refused as stale', async () => {
    const { setup, decider, worker } = await taskFlowAfterInvalidDecision();
    const stale = pendingApproval(await setup.store.load());
    decider.next.splice(0, decider.next.length, decisionJson({ confidence: 'medium', requirementAssessments: [{ requirement: 'R1', status: 'satisfied', evidence: 'test/math.test.js added' }] }));
    const reviewer = scriptedReviewer([reviewJson([])]);
    const step = await makeOrchestrator(
      setup,
      worker,
      { review: true, reviewer: reviewer.id, autoDecide: true, decisionMaker: decider.provider.id, repairOnBlockingReview: true, maxRepairsPerTask: 3 },
      { reviewer, decisionMaker: decider.provider },
    ).run('step');
    assert.deepEqual(steps(step), ['decide:ai-escalated']);
    assert.equal((await setup.store.load()).approvals.find((approval) => approval.id === stale.id)!.status, 'pending', 'not swept yet');
    assert.equal(await resolve(setup, stale.id, 'approved', 'looks fine'), 'stale');
    const state = await setup.store.load();
    assert.equal(state.approvals.find((approval) => approval.id === stale.id)!.status, 'invalidated');
    assert.equal(state.taskReviews.at(-1)!.decision, null, 'nothing was accepted');
  });

  it('H: a human who answers the request first is not overridden by a retried AI decision', async () => {
    // Rejected: the AI is not asked again about that evidence, so it can never accept over a human
    // "no"; the rejection becomes the human's remediation decision (tests/review-rejection.test.ts).
    const rejected = await taskFlowAfterInvalidDecision();
    const request = pendingApproval(await rejected.setup.store.load());
    const reviewId = (await rejected.setup.store.load()).taskReviews.at(-1)!.id;
    assert.equal(await resolve(rejected.setup, request.id, 'rejected', 'Tests are not convincing'), 'resolved');
    rejected.decider.next.splice(0, rejected.decider.next.length, VALID);
    const continued = await rejected.run();
    assert.equal(steps(continued)[0], 'apply-approval:remediation-required');
    const after = await rejected.setup.store.load();
    assert.equal(after.aiDecisions.filter((decision) => decision.reviewId === reviewId).length, 1, 'no AI retry on the rejected evidence');
    assert.deepEqual([after.taskReviews.find((review) => review.id === reviewId)!.decision?.by, after.tasks[0]!.attempts[1]!.outcome], ['human', 'review-rejected']);
    assert.equal(after.tasks[0]!.attempts[1]!.commit, null, 'the rejected attempt is never committed');

    // Approved: the human decision is used (explicitly, once); the AI is not asked again.
    const approved = await taskFlowAfterInvalidDecision();
    const pending = pendingApproval(await approved.setup.store.load());
    assert.equal(await resolve(approved.setup, pending.id, 'approved', 'Reviewed the tests myself'), 'resolved');
    approved.decider.next.splice(0, approved.decider.next.length, OVERSIZED);
    const result = await approved.run();
    assert.equal(steps(result)[0], 'apply-approval:review-accepted');
    assert.equal(approved.decider.provider.requests.length, 1);
    const state = await approved.setup.store.load();
    assert.equal(state.approvals.find((approval) => approval.id === pending.id)!.status, 'consumed');
    assert.equal(state.taskReviews.find((review) => review.taskId === state.tasks[0]!.id && review.attempt === 2)!.decision?.by, 'human');
  });

  it('I: while 1.1 stays undecided (decision attempts used up), 1.2 never starts', async () => {
    const { setup, taskId, run } = await taskFlowAfterInvalidDecision();
    for (let index = 0; index < 4; index++) {
      const again = await run();
      assert.equal(again.stop.reason, 'decision-maker-invalid-output');
      assert.ok(again.steps.every((step) => step.taskId === taskId), 'only 1.1 was acted on');
    }
    const state = await setup.store.load();
    assert.equal(state.tasks[1]!.attempts.length, 0);
    assert.equal(state.taskReviews.at(-1)!.decision, null);
  });
});
