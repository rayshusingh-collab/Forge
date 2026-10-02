import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { consumeApproval, requestApproval, resolveApproval, staleApprovals, sweepApprovals, taskApprovalBinding } from '../src/approvals/index.ts';
import { WorkflowError } from '../src/core/errors.ts';
import { decideReview } from '../src/review/index.ts';
import type { ProjectState } from '../src/state/index.ts';
import { TempDirs } from './fixtures.ts';
import { BROKEN_MULTIPLY, DIVIDE, MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, scriptedReviewer, scriptedWorker } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

/** A project whose task 1.1 passed validation and got review concerns; the run stopped and requested an approval. */
async function concernStop(): Promise<{ setup: OrchestrationSetup; approvalId: string; reviewer: ReturnType<typeof scriptedReviewer>; worker: ReturnType<typeof scriptedWorker> }> {
  const setup = await orchestrationProject(temp);
  const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]);
  const reviewer = scriptedReviewer([reviewJson([{ severity: 'warning', title: 'Missing negative test' }]), reviewJson([])]);
  const result = await makeOrchestrator(setup, worker, { review: true, reviewer: reviewer.id }, { reviewer }).run();
  assert.equal(result.stop.reason, 'review-decision-required');
  assert.ok(result.approvalId !== null && result.approvalCreated);
  return { setup, approvalId: result.approvalId, reviewer, worker };
}

function approve(state: ProjectState, id: string, reason = 'Looked at it; fine'): ProjectState {
  const approval = state.approvals.find((candidate) => candidate.id === id)!;
  const outcome = resolveApproval(state, id, 'approved', reason, new Date(), taskApprovalBinding(state, approval.type as 'review-acceptance', approval.taskId!)!.fingerprint);
  assert.equal(outcome.kind, 'resolved');
  return outcome.state;
}

describe('approval requests', () => {
  it('are created at a human stop with bounded, structured evidence', async () => {
    const { setup, approvalId } = await concernStop();
    const state = await setup.store.load();
    const approval = state.approvals.find((candidate) => candidate.id === approvalId)!;
    assert.equal(approval.type, 'review-acceptance');
    assert.equal(approval.status, 'pending');
    assert.equal(approval.taskId, state.tasks[0]!.id);
    assert.ok(approval.evidence.some((line) => /deterministic validation: passed/.test(line)));
    assert.ok(approval.evidence.some((line) => /\[warning\] Missing negative test/.test(line)));
    assert.match(approval.requestedAction, /Accept the implementation/);
    assert.match(approval.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(approval.resolution, null);
    // A second run at the same evidence points at the same request instead of creating another.
    const again = await makeOrchestrator(setup, scriptedWorker(setup.root, [{}]), { review: true, reviewer: 'fake-reviewer' }, { reviewer: scriptedReviewer([reviewJson([])]) }).run();
    assert.equal(again.approvalId, approvalId);
    assert.equal(again.approvalCreated, false);
    assert.equal((await setup.store.load()).approvals.length, 1);
  });

  it('require a non-empty reason and can be resolved only once', async () => {
    const { setup, approvalId } = await concernStop();
    const state = await setup.store.load();
    const fingerprint = state.approvals[0]!.fingerprint;
    assert.throws(() => resolveApproval(state, approvalId, 'approved', '   ', new Date(), fingerprint), /reason/);
    const resolved = resolveApproval(state, approvalId, 'rejected', 'Not acceptable', new Date(), fingerprint);
    assert.equal(resolved.kind, 'resolved');
    assert.throws(() => resolveApproval(resolved.state, approvalId, 'approved', 'changed my mind', new Date(), fingerprint), /is rejected; only a pending approval/);
    assert.equal(resolved.state.approvals[0]!.resolution?.by, 'human');
  });

  it('cannot be used unless approved, and only once', async () => {
    const { setup, approvalId } = await concernStop();
    let state = await setup.store.load();
    const fingerprint = state.approvals[0]!.fingerprint;
    assert.throws(() => consumeApproval(state, approvalId, 'run1', fingerprint, new Date()), /only an approved, unused approval/);
    state = approve(state, approvalId);
    const used = consumeApproval(state, approvalId, 'run1', fingerprint, new Date());
    assert.equal(used.kind, 'resolved');
    assert.equal(used.state.approvals[0]!.status, 'consumed');
    assert.throws(() => consumeApproval(used.state, approvalId, 'run2', fingerprint, new Date()), WorkflowError);
  });

  it('are refused (and invalidated) when the evidence changed before a decision', async () => {
    const { setup, approvalId } = await concernStop();
    let state = await setup.store.load();
    // A human decides the review through another path: the evidence the request was bound to is gone.
    state = decideReview(state, state.tasks[0]!.id, 'accepted', 'accepted directly', new Date());
    assert.deepEqual(staleApprovals(state).map((approval) => approval.id), [approvalId]);
    const outcome = resolveApproval(state, approvalId, 'approved', 'ok', new Date(), taskApprovalBinding(state, 'review-acceptance', state.tasks[0]!.id)!.fingerprint);
    assert.equal(outcome.kind, 'stale');
    assert.equal(outcome.state.approvals[0]!.status, 'invalidated');
    assert.equal(sweepApprovals(outcome.state, new Date()), outcome.state, 'nothing left to sweep');
  });

  it('are never used for changed work: an approved but stale approval is invalidated, not consumed', async () => {
    const { setup, approvalId } = await concernStop();
    let state = approve(await setup.store.load(), approvalId);
    const fingerprint = state.approvals[0]!.fingerprint;
    state = decideReview(state, state.tasks[0]!.id, 'remediation-required', 'actually redo it', new Date());
    const used = consumeApproval(state, approvalId, 'run1', taskApprovalBinding(state, 'review-acceptance', state.tasks[0]!.id)!.fingerprint, new Date());
    assert.notEqual(fingerprint, taskApprovalBinding(state, 'review-acceptance', state.tasks[0]!.id)!.fingerprint);
    assert.equal(used.kind, 'stale');
    assert.equal(used.state.approvals[0]!.status, 'invalidated');
  });

  it('supersede an older open request for the same subject when the evidence changes', () => {
    const base = { type: 'task-retry' as const, taskId: null, runId: 'r', reason: 'x', evidence: [], requestedAction: 'y', boundTo: 'z' };
    let state = { approvals: [] } as unknown as ProjectState;
    state = requestApproval(state, { ...base, id: 'a1', fingerprint: 'a'.repeat(64) }, new Date()).state;
    const second = requestApproval(state, { ...base, id: 'a2', fingerprint: 'b'.repeat(64) }, new Date());
    assert.deepEqual(second.state.approvals.map((approval) => approval.status), ['invalidated', 'pending']);
  });
});

describe('approvals in the orchestration loop', () => {
  it('approving does nothing by itself; the next run uses it once and continues', async () => {
    const { setup, approvalId, worker } = await concernStop();
    await setup.store.update((state) => approve(state, approvalId));
    const afterApproval = await setup.store.load();
    assert.equal(afterApproval.tasks[1]!.attempts.length, 0, 'approving executed nothing');
    assert.equal(worker.requests.length, 1);

    const result = await makeOrchestrator(setup, worker, { review: true, reviewer: 'fake-reviewer' }, { reviewer: scriptedReviewer([reviewJson([])]) }).run();
    assert.equal(result.stop.reason, 'complete');
    assert.equal(result.steps[0]!.action, 'apply-approval');
    assert.equal(result.steps[0]!.outcome, 'review-accepted');
    const state = await setup.store.load();
    assert.equal(state.approvals[0]!.status, 'consumed');
    assert.equal(state.approvals[0]!.consumedByRunId, result.runId);
    const decision = state.taskReviews.find((review) => review.status === 'concerns')!.decision!;
    assert.deepEqual([decision.kind, decision.by], ['accepted', 'human']);
    assert.match(decision.reason, new RegExp(approvalId.slice(0, 8)));
  });

  it('work accepted through an approval in a later run is still auto-committed before anything else runs', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]);
    const options = { review: true, reviewer: 'fake-reviewer', autoCommit: true };
    const first = await makeOrchestrator(setup, worker, options, { reviewer: scriptedReviewer([reviewJson([{ severity: 'warning', title: 'w' }])]) }).run();
    assert.equal(first.stop.reason, 'review-decision-required');
    assert.equal(first.counters.commits, 0, 'not committed while the review is undecided');
    await setup.store.update((state) => approve(state, first.approvalId!));
    const second = await makeOrchestrator(setup, worker, options, { reviewer: scriptedReviewer([reviewJson([])]) }).run();
    assert.equal(second.stop.reason, 'complete');
    assert.deepEqual(
      second.steps.map((step) => `${step.action}:${step.taskKey ?? '-'}`),
      ['apply-approval:1.1', 'commit:1.1', 'execute:1.2', 'review:1.2', 'commit:1.2', 'complete-milestone:-'],
    );
  });

  it('a rejected review-acceptance approval is applied as the human\'s remediation decision, never as acceptance or a new request', async () => {
    // Rejecting acceptance means "revise it" (tests/review-rejection.test.ts); other rejected types stop.
    const { setup, approvalId, worker } = await concernStop();
    await setup.store.update((state) => resolveApproval(state, approvalId, 'rejected', 'Concern is valid', new Date(), state.approvals[0]!.fingerprint).state);
    const result = await makeOrchestrator(setup, worker, { review: true, reviewer: 'fake-reviewer' }, { reviewer: scriptedReviewer([reviewJson([])]) }).run('step');
    assert.deepEqual(result.steps.map((step) => `${step.action}:${step.outcome}`), ['apply-approval:remediation-required']);
    assert.equal(worker.requests.length, 1, 'nothing executed in that step');
    const state = await setup.store.load();
    assert.deepEqual([state.taskReviews[0]!.decision?.kind, state.taskReviews[0]!.decision?.approvalId, state.remediations[0]!.requirements], ['remediation-required', approvalId, ['Concern is valid']]);
    assert.deepEqual(state.approvals.map((approval) => approval.status), ['rejected'], 'no new request; the rejection stays on record');
  });

  it('a task-retry approval authorizes exactly one more attempt (a repair with evidence)', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': BROKEN_MULTIPLY }, { 'src/math.js': MULTIPLY }, { 'src/math.js': DIVIDE }]);
    const first = await makeOrchestrator(setup, worker).run();
    assert.equal(first.stop.reason, 'repair-not-permitted');
    const approval = (await setup.store.load()).approvals[0]!;
    assert.equal(approval.type, 'task-retry');
    await setup.store.update((state) => resolveApproval(state, approval.id, 'approved', 'Try once more', new Date(), approval.fingerprint).state);

    const second = await makeOrchestrator(setup, worker).run();
    assert.equal(second.stop.reason, 'complete');
    assert.equal(second.steps[0]!.action, 'apply-approval');
    assert.equal(worker.requests.length, 3);
    assert.match(worker.requests[1]!.repairEvidence ?? '', /unit-tests/);
    const state = await setup.store.load();
    assert.equal(state.tasks[0]!.attempts[1]!.origin?.repair?.trigger, 'validation');
    assert.equal(state.approvals[0]!.status, 'consumed');
  });

  it('a violation acknowledgement approval allows one acknowledged retry', async () => {
    const setup = await orchestrationProject(temp);
    const { write } = await import('./git-fixtures.ts');
    const worker = scriptedWorker(setup.root, [
      async () => {
        await write(setup.root, 'src/math.js', MULTIPLY);
        await write(setup.root, '.forge/stray.txt', 'worker wrote here');
        return {};
      },
      { 'src/math.js': MULTIPLY },
      { 'src/math.js': DIVIDE },
    ]);
    await makeOrchestrator(setup, worker).run();
    const { unlink } = await import('node:fs/promises');
    await unlink(join(setup.project.layout.forgeDir, 'stray.txt'));
    const stopped = await makeOrchestrator(setup, worker).run();
    assert.equal(stopped.stop.reason, 'integrity-acknowledgement-required');
    const approval = (await setup.store.load()).approvals.find((candidate) => candidate.type === 'violation-acknowledgement')!;
    await setup.store.update((state) => resolveApproval(state, approval.id, 'approved', 'Inspected .forge; the stray file was removed', new Date(), approval.fingerprint).state);
    const result = await makeOrchestrator(setup, worker).run();
    assert.equal(result.stop.reason, 'complete');
    assert.equal(worker.requests.length, 3);
  });

  it('an interrupted-recovery approval marks the attempt failed and never re-runs it', async () => {
    const setup = await orchestrationProject(temp);
    const crashing = scriptedWorker(setup.root, [
      async () => {
        throw new Error('simulated crash');
      },
    ]);
    await assert.rejects(setup.engine.runTask('1.1', { worker: crashing, access: 'edit', timeoutMs: 60_000 }));
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const dead = { liveness: () => false };
    const stopped = await makeOrchestrator(setup, worker, {}, dead).run();
    assert.equal(stopped.stop.reason, 'interrupted-task');
    const approval = (await setup.store.load()).approvals[0]!;
    assert.equal(approval.type, 'interrupted-recovery');
    await setup.store.update((state) => resolveApproval(state, approval.id, 'approved', 'The old process is gone', new Date(), approval.fingerprint).state);
    const result = await makeOrchestrator(setup, worker, {}, dead).run();
    assert.deepEqual([result.steps[0]!.action, result.steps[0]!.outcome], ['apply-approval', 'recovered']);
    assert.equal(result.stop.reason, 'worker-failed', 'recovery only records the failure; a retry needs its own approval');
    assert.equal(worker.requests.length, 0);
    assert.equal((await setup.store.load()).tasks[0]!.attempts[0]!.outcome, 'interrupted');
  });
});

describe('only humans resolve approvals', () => {
  it('nothing outside the approval CLI calls resolveApproval', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.name.endsWith('.ts') && /resolveApproval\(/.test(await readFile(path, 'utf8'))) {
          offenders.push(path.replace(/\\/g, '/'));
        }
      }
    };
    await walk(join(import.meta.dirname, '..', 'src'));
    assert.deepEqual(
      offenders.map((path) => path.slice(path.indexOf('src/'))).sort(),
      ['src/approvals/transitions.ts', 'src/cli/commands/approval.ts'],
    );
  });

  it('a reviewer answer that tries to approve is invalid output', async () => {
    const setup = await orchestrationProject(temp);
    const worker = scriptedWorker(setup.root, [{ 'src/math.js': MULTIPLY }]);
    const reviewer = scriptedReviewer([JSON.stringify({ ...JSON.parse(reviewJson([])), approve: true, approvalStatus: 'approved' })]);
    const result = await makeOrchestrator(setup, worker, { review: true, reviewer: reviewer.id }, { reviewer }).run();
    assert.equal(result.stop.reason, 'reviewer-unavailable');
    assert.ok((await setup.store.load()).approvals.every((approval) => approval.resolution === null));
  });
});
