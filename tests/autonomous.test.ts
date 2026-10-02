import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { after, describe, it } from 'node:test';

import type { AiRequest, AiResponse } from '../src/ai/index.ts';
import { formatRunResult, formatStep } from '../src/cli/run-format.ts';
import { runCli } from '../src/cli/run-cli.ts';
import type { CliContext } from '../src/cli/types.ts';
import { silentLogger } from '../src/logging/index.ts';
import { AUTONOMOUS_DEFAULTS, buildPolicy, resolvePolicy, workerTimeoutFor } from '../src/orchestration/index.ts';
import type { PolicyOptions, RunResult } from '../src/orchestration/index.ts';
import { openStateStore } from '../src/projects/index.ts';
import { ORCHESTRATION_LIMITS } from '../src/state/index.ts';
import type { ProjectState } from '../src/state/index.ts';
import { budgetUsage } from '../src/tasks/index.ts';
import type { WorkerOutcome } from '../src/workers/index.ts';
import { FakeAiProvider, aiRegistry } from './ai-fixtures.ts';
import { TempDirs } from './fixtures.ts';
import { git, write } from './git-fixtures.ts';
import { CapturingWriter } from './helpers.ts';
import { BASE, MULTIPLY, makeOrchestrator, orchestrationProject, reviewJson, scriptedReviewer } from './orchestration-fixtures.ts';
import type { OrchestrationSetup } from './orchestration-fixtures.ts';
import { FakeWorker, fakeRegistry } from './worker-fixtures.ts';

/**
 * Hands-off autonomous completion (`forge run --autonomous`): recoverable
 * engineering events are handled within explicit budgets, and every hard
 * safety boundary still stops. Modelled on the real TaskFlow runs: task 3.2
 * (a Codex timeout after writing safe partial work) and tasks 2.4 / 3.1
 * (a medium-confidence acceptance caused by truncated review evidence).
 */

const temp = new TempDirs();
after(() => temp.cleanup());

// ------------------------------------------------------------------ fixtures

/** One scripted worker call: files to write, then how the invocation ends. */
interface WorkStep {
  readonly files?: Readonly<Record<string, string>>;
  readonly outcome?: WorkerOutcome;
  readonly summary?: string | null;
  /** Commit everything first (moves HEAD: a scope violation). */
  readonly commit?: boolean;
}

/**
 * A fake implementer for several tasks: each task's instruction contains a
 * tag such as `[T1]`; call N for a tag uses its Nth step (the last repeats).
 */
function taskWorker(root: string, scripts: Readonly<Record<string, readonly WorkStep[]>>, id = 'fake'): FakeWorker {
  const calls = new Map<string, number>();
  return new FakeWorker(
    async (request) => {
      const tag = Object.keys(scripts).find((candidate) => request.task.includes(candidate));
      if (tag === undefined) {
        throw new Error(`no script for task: ${request.task}`);
      }
      const call = calls.get(tag) ?? 0;
      calls.set(tag, call + 1);
      const steps = scripts[tag]!;
      const step = steps[Math.min(call, steps.length - 1)]!;
      for (const [path, content] of Object.entries(step.files ?? {})) {
        await write(root, path, content);
      }
      if (step.commit === true) {
        await git(root, 'add', '-A');
        await git(root, 'commit', '-qm', 'worker committed on its own');
      }
      const outcome = step.outcome ?? 'success';
      return { outcome, summary: step.summary === undefined ? (outcome === 'success' ? 'Done.' : null) : step.summary, diagnostics: outcome === 'success' ? [] : [`worker ${outcome}`] };
    },
    { id },
  );
}

/** A project with milestones of tagged tasks (no dependencies) and the math check (fails while src/math.js contains BUG). */
async function project(milestones: readonly (readonly string[])[]): Promise<OrchestrationSetup> {
  const setup = await orchestrationProject(temp, { tasks: false });
  for (const [index, tags] of milestones.entries()) {
    await setup.engine.addMilestone({ title: `Milestone ${index + 1}` });
    for (const tag of tags) {
      await setup.engine.addTask({ milestone: String(index + 1), title: `Task ${tag}`, instruction: `Implement ${tag} in src/` });
    }
  }
  return setup;
}

/** Decision-maker answer for whatever the packet asks it to assess. */
function decisionFor(input: string, verdict: 'accept' | 'reject' | 'escalate', confidence: 'low' | 'medium' | 'high'): string {
  const labels = (/outstanding requirements: ([^\n]*)/.exec(input)?.[1]?.match(/R\d+/g) ?? []) as string[];
  const findings = (/reviewer findings to assess: ([^;]*);/.exec(input)?.[1]?.match(/\d+/g) ?? []).map(Number);
  return JSON.stringify({
    decision: verdict,
    confidence,
    reason: `${verdict} at ${confidence} confidence`,
    findingAssessments: findings.map((finding) => ({ finding, status: verdict === 'reject' ? 'unresolved' : 'acceptable', note: 'n' })),
    requirementAssessments: labels.map((requirement) => ({ requirement, status: 'satisfied', evidence: 'files changed' })),
    requiredActions: verdict === 'reject' ? ['Fix it'] : [],
    humanReason: verdict === 'escalate' ? 'product question' : null,
  });
}

/**
 * A decision-maker whose confidence follows what it could SEE: when Forge's
 * packet says the change evidence is truncated it accepts only with medium
 * confidence, otherwise with high confidence (the TaskFlow 2.4 / 3.1 pattern).
 */
function evidenceSensitiveDecider(id = 'fake-decider'): FakeAiProvider {
  return new FakeAiProvider(async (request) => ({ text: decisionFor(request.input, 'accept', /change evidence is TRUNCATED/.test(request.input) ? 'medium' : 'high') }), id);
}

const CLEAR = reviewJson([]);
const CONCERN = reviewJson([{ severity: 'warning', title: 'Minor naming issue' }]);
const AUTO: PolicyOptions = { autonomous: true, reviewer: 'fake-reviewer', decisionMaker: 'fake-decider', retryBackoffMs: 0 };

const steps = (result: RunResult) => result.steps.map((step) => `${step.action}:${step.outcome}`);

async function commits(root: string): Promise<number> {
  return Number((await git(root, 'rev-list', '--count', 'HEAD')).trim());
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  return items[0]!;
}

// --------------------------------------------------------------------- tests

describe('autonomous policy', () => {
  it('turns on the safe automation defaults, with bounded adaptive timeouts (600 s -> 900 s -> 1200 s cap)', () => {
    const policy = buildPolicy({ autonomous: true }, { workerTimeoutMs: 600_000 });
    assert.equal(policy.autonomous, true);
    assert.deepEqual(
      [policy.access, policy.review.enabled, policy.decision.enabled, policy.repair.onValidationFailure, policy.repair.onBlockingReview, policy.autoCommit],
      ['edit', true, true, true, true, true],
    );
    assert.deepEqual([policy.maxTasks, policy.maxSteps, policy.repair.maxPerTask], [ORCHESTRATION_LIMITS.maxTasks, ORCHESTRATION_LIMITS.maxSteps, 3]);
    assert.deepEqual(policy.recovery, { timeoutRecoveries: 2, timeoutIncreaseMs: 300_000, maxWorkerTimeoutMs: 1_200_000, providerRetries: 2, retryBackoffMs: 5_000, evidenceReviews: 1 });
    assert.deepEqual([null, 1, 2, 3].map((n) => workerTimeoutFor(policy, n)), [600_000, 900_000, 1_200_000, 1_200_000], 'never above the hard cap');
  });

  it('explicit options still win; without --autonomous nothing changes (all recovery budgets are 0)', () => {
    const custom = buildPolicy({ autonomous: true, autoCommit: false, timeoutRecoveries: 1, maxWorkerTimeoutMs: 700_000 }, { workerTimeoutMs: 600_000 });
    assert.deepEqual([custom.autoCommit, custom.recovery.timeoutRecoveries, custom.recovery.maxWorkerTimeoutMs], [false, 1, 700_000]);
    const standard = buildPolicy({}, { workerTimeoutMs: 600_000 });
    assert.equal(standard.autonomous, false);
    assert.deepEqual(standard.recovery, { timeoutRecoveries: 0, timeoutIncreaseMs: 0, maxWorkerTimeoutMs: 600_000, providerRetries: 0, retryBackoffMs: 0, evidenceReviews: 0 });
    assert.deepEqual([standard.access, standard.review.enabled, standard.autoCommit, standard.maxTasks], ['read-only', false, false, 5]);
  });

  it('refuses values beyond the hard limits instead of clamping them, and is enabled by project configuration', () => {
    assert.throws(() => buildPolicy({ autonomous: true, timeoutRecoveries: ORCHESTRATION_LIMITS.maxTimeoutRecoveries + 1 }, { workerTimeoutMs: 600_000 }), /timeoutRecoveries must be <= 5/);
    assert.throws(() => buildPolicy({ autonomous: true, evidenceReviews: 4 }, { workerTimeoutMs: 600_000 }), /evidenceReviews must be <= 3/);
    assert.throws(() => buildPolicy({ maxWorkerTimeoutMs: 1_000 }, { workerTimeoutMs: 600_000 }), /must be at least the normal worker timeout/);
    const fromProject = resolvePolicy({}, { 'run.autonomous': true, 'run.timeoutRecoveries': 1 }, { workerTimeoutMs: 600_000 });
    assert.deepEqual([fromProject.policy.autonomous, fromProject.policy.recovery.timeoutRecoveries, fromProject.policy.autoCommit], [true, 1, true]);
    assert.equal(AUTONOMOUS_DEFAULTS.access, 'edit');
  });
});

describe('TaskFlow 3.2 regression: worker timeout with safe partial work', () => {
  const PARTIAL = { 'src/shell/AppLayout.js': 'export const AppLayout = () => null;\n', 'src/math.js': MULTIPLY };
  const FINISH = { 'src/shell/Router.js': 'export const routes = [];\n' };

  it('autonomous: timeout -> safe attribution confirmed -> partial work kept -> continuation with a longer timeout -> validate -> review -> commit -> next task, no human', async () => {
    const setup = await project([['[T1]', '[T2]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: PARTIAL, outcome: 'timeout' }, { files: FINISH }], '[T2]': [{ files: { 'src/t2.js': 'export const t2 = 2;\n' } }] });
    const reviewer = scriptedReviewer([CLEAR]);
    const decider = evidenceSensitiveDecider();
    const before = await commits(setup.root);
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer, decisionMaker: decider }).run();

    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result), [
      'execute:timeout',
      'repair:validated',
      'review:clear',
      'commit:committed',
      'execute:validated',
      'review:clear',
      'commit:committed',
      'complete-milestone:completed',
    ]);
    assert.deepEqual(worker.requests.map((request) => request.timeoutMs), [60_000, 90_000, 60_000], 'the continuation got a longer, bounded timeout');
    const continuation = worker.requests[1]!.repairEvidence ?? '';
    for (const text of [/timed out after about \d+ seconds/, /Safe partial changes from that attempt remain in the working tree \(2 file\(s\)/, /Inspect the existing implementation and continue the same task\. Do not restart completed work/, /Validation status: not yet established/, /Time limit for this attempt: 90 seconds/]) {
      assert.match(continuation, text);
    }

    const state = await setup.store.load();
    const task = state.tasks[0]!;
    assert.deepEqual(task.attempts.map((attempt) => [attempt.outcome, attempt.origin?.repair?.trigger ?? null, attempt.validation?.status ?? null]), [
      ['timeout', null, null],
      ['validated', 'timeout', 'passed'],
    ]);
    assert.deepEqual(budgetUsage(state, task), { implementationAttempts: 1, maxAttempts: 3, validationRepairs: 0, reviewRepairs: 0, timeoutRecoveries: 1, providerRetries: 0, evidenceReviews: 0 }, 'the continuation consumed no implementation attempt or repair');
    const committed = (await git(setup.root, 'show', '--name-only', '--format=', 'HEAD~1')).trim().split('\n').sort();
    assert.deepEqual(committed, ['src/math.js', 'src/shell/AppLayout.js', 'src/shell/Router.js'], 'the preserved partial work is committed with the continuation');
    assert.equal(await commits(setup.root), before + 2);
    assert.deepEqual(state.approvals, [], 'no human approval was requested');
    assert.deepEqual([result.counters.timeoutRecoveries, result.counters.repairs, result.counters.humanInterventions], [1, 0, 0]);

    const output = result.steps.map(formatStep).join('');
    assert.match(output, /Worker timed out after 60s\n {2}Partial work: 2 changed file\(s\) kept/);
    assert.match(output, /Recovery: continuing the timed-out attempt \(timeout recovery 1\/2, worker timeout 90s\)/);
    const summary = formatRunResult(result);
    for (const line of [/Outcome:\s+WORKFLOW COMPLETE/, /Timeout recoveries:\s+1/, /Human interventions:\s+0/, /Commits:\s+2/, /Milestones completed:\s+1/]) {
      assert.match(summary, line);
    }
  });

  it('timeout with zero changes: a bounded retry that asks for a more focused approach', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ outcome: 'timeout' }, { files: { 'src/math.js': MULTIPLY } }] });
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result).slice(0, 2), ['execute:timeout', 'repair:validated']);
    assert.match(worker.requests[1]!.repairEvidence ?? '', /produced no usable changes\.\nTake a more focused approach/);
  });

  it('timeouts until the recovery budget is exhausted: STOP with the precise reason; implementation attempts untouched', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, {
      '[T1]': [
        { files: { 'src/a.js': 'a\n' }, outcome: 'timeout' },
        { files: { 'src/b.js': 'b\n' }, outcome: 'timeout' },
        { files: { 'src/c.js': 'c\n' }, outcome: 'timeout' },
      ],
    });
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(result.stop.reason, 'timeout-recovery-exhausted');
    assert.match(result.stop.detail ?? '', /2\/2 timeout recoveries used/);
    assert.deepEqual(worker.requests.map((request) => request.timeoutMs), [60_000, 90_000, 120_000]);
    const state = await setup.store.load();
    assert.deepEqual(budgetUsage(state, state.tasks[0]!).implementationAttempts, 1);
    assert.equal(only(state.approvals).type, 'task-retry', 'a human decides what happens next');
    assert.match(formatRunResult(result), /TIMEOUT RECOVERY EXHAUSTED/);
  });

  it('without --autonomous a timeout still stops for a human exactly as before', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: PARTIAL, outcome: 'timeout' }, { files: FINISH }] });
    const result = await makeOrchestrator(setup, worker, { review: true, reviewer: 'fake-reviewer' }, { reviewer: scriptedReviewer([CLEAR]) }).run();
    assert.equal(result.stop.reason, 'worker-failed');
    assert.equal(worker.requests.length, 1);
    assert.equal(only((await setup.store.load()).approvals).type, 'task-retry');
  });
});

describe('unsafe timeouts are hard stops (existing safety machinery, not a weaker copy)', () => {
  async function timedOut(script: WorkStep, prepare?: (setup: OrchestrationSetup) => Promise<void>) {
    const setup = await project([['[T1]', '[T2]']]);
    await prepare?.(setup);
    const worker = taskWorker(setup.root, { '[T1]': [script, { files: { 'src/fix.js': 'x\n' } }], '[T2]': [{ files: { 'src/t2.js': 't2\n' } }] });
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    const state = await setup.store.load();
    assert.equal(worker.requests.length, 1, 'never continued automatically');
    assert.equal(state.tasks[1]!.attempts.length, 0, 'the next task never started');
    return { result, state };
  }

  it('scope violation (the worker moved HEAD) -> STOP', async () => {
    const { result } = await timedOut({ files: { 'src/x.js': 'x\n' }, commit: true, outcome: 'timeout' });
    assert.equal(result.stop.reason, 'unsafe-partial-work');
    assert.match(result.stop.detail ?? '', /HEAD or the current branch changed during the task/);
  });

  it('mixed attribution (a file that already had uncommitted changes) -> STOP', async () => {
    const { result } = await timedOut({ files: { 'README.md': '# Demo\nworker edit\n' }, outcome: 'timeout' }, async (setup) => {
      await write(setup.root, 'README.md', '# Demo\nhuman edit in progress\n');
    });
    assert.equal(result.stop.reason, 'unsafe-partial-work');
    assert.match(result.stop.detail ?? '', /already had uncommitted changes before the task/);
  });

  it('protected-path mutation (.forge/) during the timed-out run -> integrity violation, never recovered', async () => {
    const { result, state } = await timedOut({ files: { '.forge/rogue.txt': 'x\n', 'src/x.js': 'x\n' }, outcome: 'timeout' });
    assert.equal(result.stop.reason, 'integrity-violation');
    assert.equal(state.tasks[0]!.attempts[0]!.outcome, 'integrity-violation');
  });

  it('cancellation is never retried', async () => {
    const { result } = await timedOut({ outcome: 'cancelled' });
    assert.equal(result.stop.reason, 'worker-failed');
  });
});

describe('provider transient failures', () => {
  it('a failed worker invocation is retried within the provider-retry budget (a recovery, not an implementation attempt)', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ outcome: 'failed' }, { files: { 'src/math.js': MULTIPLY } }] });
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result).slice(0, 2), ['execute:failed', 'repair:validated']);
    assert.equal(result.steps[1]!.repair?.trigger, 'worker-failure');
    assert.equal(result.counters.providerRetries, 1);
    const state = await setup.store.load();
    assert.equal(budgetUsage(state, state.tasks[0]!).implementationAttempts, 1);
  });

  it('a worker failing every time stops with PROVIDER RETRY BUDGET EXHAUSTED', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ outcome: 'failed' }] });
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(result.stop.reason, 'provider-retry-exhausted');
    assert.equal(worker.requests.length, 3, 'the first attempt and 2 retries');
  });

  it('an unavailable worker (no attempt recorded) is retried after a backoff, then gives up precisely', async () => {
    class FlakyWorker extends FakeWorker {
      private checks = 0;
      private readonly unavailableChecks: number;
      constructor(root: string, unavailableChecks: number) {
        super(async () => {
          await write(root, 'src/math.js', MULTIPLY);
          return {};
        });
        this.unavailableChecks = unavailableChecks;
      }
      override async healthCheck() {
        this.checks += 1;
        const health = await super.healthCheck();
        return this.checks <= this.unavailableChecks ? { ...health, available: false, checks: [{ name: 'executable', ok: false, detail: 'temporarily unreachable' }] } : health;
      }
    }
    const recovering = await project([['[T1]']]);
    const flaky = new FlakyWorker(recovering.root, 2);
    const ok = await makeOrchestrator(recovering, flaky, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(ok.stop.reason, 'complete');
    assert.equal(ok.counters.providerRetries, 1);

    const down = await project([['[T1]']]);
    const dead = new FlakyWorker(down.root, 1_000);
    const stopped = await makeOrchestrator(down, dead, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    assert.equal(stopped.stop.reason, 'provider-retry-exhausted');
    assert.match(stopped.stop.detail ?? '', /after 2 provider retries/);
    assert.equal((await down.store.load()).tasks[0]!.attempts.length, 0, 'an unavailable worker never consumes an attempt');
  });

  it('reviewer and decision-maker failures are retried in the same run within the budget', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: { 'src/math.js': MULTIPLY } }] });
    const reviewer = scriptedReviewer([{ outcome: 'unavailable' }, CONCERN]);
    let calls = 0;
    const decider = new FakeAiProvider(async (request) => (++calls === 1 ? { text: 'not json' } : { text: decisionFor(request.input, 'accept', 'high') }), 'fake-decider');
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer, decisionMaker: decider }).run();
    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result).slice(0, 6), ['execute:validated', 'review:unavailable', 'review:concerns', 'decide:ai-escalated', 'decide:ai-accepted', 'commit:committed']);
    assert.equal(result.counters.providerRetries, 2);
  });
});

describe('evidence expansion (TaskFlow 2.4 / 3.1 regression): medium confidence caused by truncated evidence', () => {
  /** Larger than one file's default review/decision excerpt (8 kB) but within one expanded round (32 kB). */
  const LARGE = `${MULTIPLY}${'// implementation detail the reviewer needs to see\n'.repeat(400)}`;
  /** Larger than any single expansion round shows. */
  const HUGE = `${MULTIPLY}${'// implementation detail the reviewer needs to see\n'.repeat(4_000)}`;

  async function concernsOn(content: string, decider = evidenceSensitiveDecider()) {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: { 'src/math.js': content } }] });
    const reviewer = scriptedReviewer([CONCERN]);
    const result = await makeOrchestrator(setup, worker, AUTO, { reviewer, decisionMaker: decider }).run();
    return { setup, result, reviewer, decider, state: await setup.store.load() };
  }

  it('does not ask a human: collects the missing evidence, re-reviews, re-decides, accepts with high confidence, commits', async () => {
    const { result, reviewer, decider, state } = await concernsOn(LARGE);
    assert.equal(result.stop.reason, 'complete');
    assert.deepEqual(steps(result), ['execute:validated', 'review:concerns', 'decide:ai-escalated', 'review:concerns', 'decide:ai-accepted', 'commit:committed', 'complete-milestone:completed']);
    assert.deepEqual(state.taskReviews.map((review) => [review.evidenceRound, review.context.truncated]), [[0, true], [1, false]]);
    assert.ok(reviewer.requests[1]!.input.length > reviewer.requests[0]!.input.length, 'the re-review saw more');
    assert.deepEqual(state.aiDecisions.map((decision) => [decision.confidence, decision.effect]), [['medium', 'escalated'], ['high', 'accepted']]);
    assert.deepEqual(state.approvals, []);
    assert.equal(budgetUsage(state, state.tasks[0]!).implementationAttempts, 1, 'no implementation repair was consumed: no code changed');
    assert.equal(result.counters.evidenceReviews, 1);
    assert.equal(decider.requests.length, 2);
  });

  it('if uncertainty remains after the bounded expansion: human escalation with the precise reason', async () => {
    const { result, reviewer, state } = await concernsOn(HUGE);
    assert.equal(result.stop.reason, 'evidence-review-exhausted');
    assert.equal(reviewer.requests.length, 2, 'one expansion, never the same evidence again');
    assert.equal(only(state.approvals).type, 'review-acceptance');
    assert.equal(state.tasks[0]!.attempts[0]!.commit, null);
  });

  it('medium confidence with COMPLETE evidence (the work may be wrong) is not re-reviewed', async () => {
    const decider = new FakeAiProvider(async (request) => ({ text: decisionFor(request.input, 'accept', 'medium') }), 'fake-decider');
    const { result, reviewer } = await concernsOn(MULTIPLY, decider);
    assert.equal(result.stop.reason, 'decision-overruled');
    assert.equal(reviewer.requests.length, 1);
  });
});

describe('continuation across restarts (crash safety)', () => {
  it('step by step with a fresh process each time: one continuation, one commit, no duplicates', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: { 'src/a.js': 'a\n', 'src/math.js': MULTIPLY }, outcome: 'timeout' }, { files: { 'src/b.js': 'b\n' } }] });
    const outcomes: string[] = [];
    for (let step = 0; step < 6; step += 1) {
      const fresh = { ...setup, store: openStateStore(setup.project) };
      const result = await makeOrchestrator(fresh, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run('step');
      outcomes.push(...steps(result));
      if (result.stop.reason !== 'step-done') {
        outcomes.push(`stop:${result.stop.reason}`);
        break;
      }
    }
    assert.deepEqual(outcomes, ['execute:timeout', 'repair:validated', 'review:clear', 'commit:committed', 'complete-milestone:completed', 'stop:complete']);
    const state = await setup.store.load();
    assert.deepEqual(budgetUsage(state, state.tasks[0]!).timeoutRecoveries, 1);
    assert.equal(worker.requests.length, 2);
  });

  it('an autonomous run takes over a lease only when its owner is provably dead; otherwise the run refuses', async () => {
    const setup = await project([['[T1]']]);
    const worker = new FakeWorker(async () => {
      await write(setup.root, 'src/math.js', MULTIPLY);
      return {};
    }, { id: 'claude' });
    // A previous `forge run` crashed: its run is still recorded as running and its lock file remains.
    await makeOrchestrator(setup, worker, { maxSteps: 1 }).run();
    const runId = (
      await setup.store.update((current) => ({
        ...current,
        orchestrationRuns: current.orchestrationRuns.map((run) => ({ ...run, status: 'running', finishedAt: null, stop: null, owner: { pid: 999_999_999, host: hostname() } })),
      }))
    ).orchestrationRuns[0]!.id;
    const lock = JSON.stringify({ runId, pid: 999_999_999, host: hostname(), acquiredAt: new Date().toISOString(), token: 'abc123' });
    await write(setup.root, '.forge/orchestration.lock', lock);

    const standard = cli(setup.root, worker);
    assert.equal(await standard.run(['run', '--allow-edits']), 1, 'a normal run never takes over a lease');

    const autonomous = cli(setup.root, worker);
    const code = await autonomous.run(['run', '--autonomous', '--retry-backoff', '0']);
    assert.match(autonomous.stdout.text, /Recovered the stale orchestration lease of crashed run .{8} \(pid 999999999, which no longer exists\); continuing/);
    assert.equal(code, 0, autonomous.stderr.text + autonomous.stdout.text);
    const state = await setup.store.load();
    assert.equal(state.orchestrationRuns[0]!.status, 'interrupted');
    assert.ok(state.controlEvents.some((event) => event.kind === 'lease-recovered' && /autonomous run/.test(event.reason ?? '')));
  });
});

/** The real CLI with injected fakes: one `claude` worker and one `claude` AI provider acting as reviewer and decision-maker. */
function cli(cwd: string, worker: FakeWorker, ai: FakeAiProvider = roleProvider({}), env: Record<string, string> = {}) {
  const stdout = new CapturingWriter();
  const stderr = new CapturingWriter();
  const context: CliContext = {
    stdout,
    stderr,
    env,
    cwd,
    version: 'test',
    nodeVersion: process.version,
    nodeExecutable: process.execPath,
    logger: silentLogger,
    workers: fakeRegistry(worker),
    aiProviders: aiRegistry(ai),
  };
  return { stdout, stderr, run: (args: string[]) => runCli(args, context) };
}

/**
 * One AI provider serving both roles, scripted per task tag: `reviews[tag]`
 * is the Nth review answer for that task (last repeats; default clear); the
 * decision-maker is evidence-sensitive (medium on truncated evidence).
 */
function roleProvider(reviews: Readonly<Record<string, readonly (string | { outcome: 'unavailable' })[]>>): FakeAiProvider {
  const counts = new Map<string, number>();
  return new FakeAiProvider(async (request: AiRequest): Promise<Partial<AiResponse>> => {
    if (request.role === 'decision-maker') {
      return { text: decisionFor(request.input, 'accept', /change evidence is TRUNCATED/.test(request.input) ? 'medium' : 'high') };
    }
    const tag = Object.keys(reviews).find((candidate) => request.input.includes(candidate));
    const answers = tag === undefined ? [CLEAR] : reviews[tag]!;
    const call = counts.get(tag ?? '') ?? 0;
    counts.set(tag ?? '', call + 1);
    const answer = answers[Math.min(call, answers.length - 1)]!;
    return typeof answer === 'string' ? { text: answer } : { outcome: answer.outcome, text: null, diagnostic: 'reviewer unavailable' };
  }, 'claude');
}

describe('FULL PROJECT: one `forge run --autonomous` from the initial state to WORKFLOW COMPLETE', () => {
  const BUG = `${BASE}export const subtract = (a, b) => a + b; // BUG\n`;
  const LARGE = `export const big = 1;\n${'// a long implementation the reviewer must read\n'.repeat(400)}`;
  const BLOCKING = reviewJson([{ severity: 'error', title: 'negate returns the wrong sign', remediation: 'Return -x' }]);

  function simulatedWorker(root: string): FakeWorker {
    return taskWorker(
      root,
      {
        // Milestone 1: plain success (with an advisory warning accepted by the decision-maker),
        // validation failure then repair, blocking review concern then repair.
        '[T1]': [{ files: { 'src/t1.js': 'export const one = 1;\n' } }],
        '[T2]': [{ files: { 'src/math.js': BUG } }, { files: { 'src/math.js': `${BASE}export const subtract = (a, b) => a - b;\n` } }],
        '[T3]': [{ files: { 'src/t3.js': 'export const negate = (x) => x;\n' } }, { files: { 'src/t3.js': 'export const negate = (x) => -x;\n' } }],
        // Milestone 2: timeout with partial work, timeout with nothing, transient worker failure, truncated review evidence.
        '[T4]': [{ files: { 'src/t4/layout.js': 'export const layout = 1;\n' }, outcome: 'timeout' }, { files: { 'src/t4/router.js': 'export const router = 1;\n' } }],
        '[T5]': [{ outcome: 'timeout' }, { files: { 'src/t5.js': 'export const five = 5;\n' } }],
        '[T6]': [{ outcome: 'failed' }, { files: { 'src/t6.js': 'export const six = 6;\n' } }],
        '[T7]': [{ files: { 'src/t7.js': LARGE } }],
      },
      'claude',
    );
  }

  it('completes every milestone without a single human action', async () => {
    const setup = await project([
      ['[T1]', '[T2]', '[T3]'],
      ['[T4]', '[T5]', '[T6]', '[T7]'],
    ]);
    const before = await commits(setup.root);
    const worker = simulatedWorker(setup.root);
    const ai = roleProvider({ '[T1]': [CONCERN], '[T3]': [BLOCKING, CLEAR], '[T5]': [{ outcome: 'unavailable' }, CLEAR], '[T7]': [CONCERN] });
    const run = cli(setup.root, worker, ai);
    const code = await run.run(['run', '--autonomous', '--retry-backoff', '0']);
    const out = run.stdout.text;
    assert.equal(code, 0, `${run.stderr.text}\n${out}`);

    assert.match(out, /FORGE RUN --AUTONOMOUS/);
    assert.match(out, /Mode:\s+AUTONOMOUS/);
    for (const line of [
      /Outcome:\s+WORKFLOW COMPLETE/,
      /Tasks processed:\s+7/,
      /Repairs:\s+2/,
      /Timeout recoveries:\s+2/,
      /Provider retries:\s+2/,
      /Evidence re-reviews:\s+1/,
      /Commits:\s+7/,
      /Milestones completed:\s+2/,
      /Human interventions:\s+0/,
      /Human action required: none/,
    ]) {
      assert.match(out, line);
    }
    assert.match(out, /Recovery: continuing the timed-out attempt \(timeout recovery 1\/2/);
    assert.match(out, /Recovery: retrying after a worker failure \(provider retry 1\/2\)/);

    const state = await setup.store.load();
    assert.ok(state.tasks.every((task) => task.status === 'succeeded'));
    assert.ok(state.milestones.every((milestone) => milestone.status === 'completed'));
    assert.deepEqual(state.approvals, [], 'no approval was ever requested');
    assert.equal(await commits(setup.root), before + 7);
    const byTag = (tag: string) => state.tasks.find((task) => task.title.includes(tag))!;
    assert.deepEqual(byTag('[T2]').attempts.map((attempt) => attempt.origin?.repair?.trigger ?? 'first'), ['first', 'validation']);
    assert.deepEqual(byTag('[T3]').attempts.map((attempt) => attempt.origin?.repair?.trigger ?? 'first'), ['first', 'review']);
    assert.deepEqual(byTag('[T4]').attempts.map((attempt) => attempt.origin?.repair?.trigger ?? 'first'), ['first', 'timeout']);
    assert.deepEqual(byTag('[T6]').attempts.map((attempt) => attempt.origin?.repair?.trigger ?? 'first'), ['first', 'worker-failure']);
    assert.ok(state.aiDecisions.some((decision) => decision.effect === 'accepted' && decision.confidence === 'high'));
  });

  it('a real hard safety violation in the same kind of run STOPS it', async () => {
    const setup = await project([['[T1]', '[T2]'], ['[T3]']]);
    const worker = taskWorker(
      setup.root,
      {
        '[T1]': [{ files: { 'src/t1.js': 'export const one = 1;\n' } }],
        // The worker tampers with Forge's own state while it works.
        '[T2]': [{ files: { 'src/t2.js': 'export const two = 2;\n', '.forge/rogue-notes.txt': 'tampered\n' } }],
        '[T3]': [{ files: { 'src/t3.js': 'export const three = 3;\n' } }],
      },
      'claude',
    );
    const before = await commits(setup.root);
    const run = cli(setup.root, worker, roleProvider({}));
    assert.equal(await run.run(['run', '--autonomous', '--retry-backoff', '0']), 1);
    assert.match(run.stdout.text, /STOP: INTEGRITY VIOLATION/);
    assert.equal(worker.requests.length, 2, 'nothing ran after the violation');
    assert.equal(await commits(setup.root), before + 1, 'only the task before the violation was committed');
  });
});

describe('visibility: task show, explain, dry run', () => {
  it('shows each budget separately', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: { 'src/a.js': 'a\n' }, outcome: 'timeout' }, { files: { 'src/b.js': 'b\n' }, outcome: 'timeout' }, { outcome: 'timeout' }] });
    await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    const show = cli(setup.root, worker);
    assert.equal(await show.run(['task', 'show', '1.1']), 0);
    assert.match(show.stdout.text, /Attempts:\s+3 recorded; 1 of 3 implementation attempts used/);
    assert.match(show.stdout.text, /Budgets:\s+implementation attempts 1\/3; repairs 0 \(validation 0, review 0\); timeout recoveries 2; provider retries 0; evidence re-reviews 0/);
    const explain = cli(setup.root, worker);
    assert.equal(await explain.run(['explain']), 0);
    assert.match(explain.stdout.text, /kept timing out and its timeout-recovery budget is used up/);
    assert.match(explain.stdout.text, /Budgets used: implementation attempts 1\/3; repairs 0\/3 \(validation 0, review 0\); timeout recoveries 2\/2/);
  });

  it('the dry run documents autonomous mode and its budgets, and project configuration can enable it', async () => {
    const setup = await project([['[T1]']]);
    const worker = new FakeWorker(async () => ({}), { id: 'claude' });
    assert.equal(await cli(setup.root, worker).run(['config', 'set', 'run.autonomous', 'true']), 0);
    const dry = cli(setup.root, worker);
    assert.equal(await dry.run(['run', '--dry-run', '--timeout', '600']), 0, dry.stderr.text);
    assert.match(dry.stdout.text, /Mode:\s+AUTONOMOUS \(recoverable events handled within budgets; hard stops unchanged\)/);
    assert.match(dry.stdout.text, /Recovery:\s+timeout recovery 2\/task \(900 s -> 1200 s, cap 1200 s\); provider retries 2 \(backoff 5 s x n\); evidence re-reviews 1\/attempt/);
    assert.match(dry.stdout.text, /project config \[autonomous\]/);
  });
});

describe('schema 11 migration', () => {
  it('upgrades a version 10 document (no evidence rounds, recovery policy or counters) and refuses one that already has them', async () => {
    const setup = await project([['[T1]']]);
    const worker = taskWorker(setup.root, { '[T1]': [{ files: { 'src/math.js': MULTIPLY } }] });
    await makeOrchestrator(setup, worker, AUTO, { reviewer: scriptedReviewer([CLEAR]), decisionMaker: evidenceSensitiveDecider() }).run();
    const doc = JSON.parse(await readFile(setup.project.layout.stateFile, 'utf8')) as Record<string, unknown> & ProjectState;
    const v10 = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    v10['schemaVersion'] = 10;
    for (const review of v10['taskReviews'] as Record<string, unknown>[]) {
      delete review['evidenceRound'];
    }
    for (const run of v10['orchestrationRuns'] as Record<string, Record<string, unknown>>[]) {
      delete run['policy']!['autonomous'];
      delete run['policy']!['recovery'];
      for (const counter of ['timeoutRecoveries', 'providerRetries', 'evidenceReviews', 'humanInterventions']) {
        delete run['counters']![counter];
      }
    }
    await write(setup.root, '.forge/state.json', JSON.stringify(v10));
    const migrated = await openStateStore(setup.project).load();
    assert.equal(migrated.schemaVersion, 11);
    assert.ok(migrated.taskReviews.every((review) => review.evidenceRound === 0));
    const run = migrated.orchestrationRuns[0]!;
    assert.equal(run.policy.autonomous, false, 'older runs were never autonomous');
    assert.deepEqual(run.policy.recovery, { timeoutRecoveries: 0, timeoutIncreaseMs: 0, maxWorkerTimeoutMs: run.policy.workerTimeoutMs, providerRetries: 0, retryBackoffMs: 0, evidenceReviews: 0 });
    assert.deepEqual([run.counters.timeoutRecoveries, run.counters.providerRetries, run.counters.evidenceReviews, run.counters.humanInterventions], [0, 0, 0, 0]);

    await write(setup.root, '.forge/state.json', JSON.stringify({ ...doc, schemaVersion: 10 }));
    await assert.rejects(openStateStore(setup.project).load(), /evidenceRound is not a recognised field in schema version 10/);
  });
});

