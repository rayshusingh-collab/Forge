import { ProcessRunner } from '../src/execution/index.ts';
import { Orchestrator, buildPolicy } from '../src/orchestration/index.ts';
import type { OrchestrationReporter, PolicyOptions } from '../src/orchestration/index.ts';
import { openStateStore } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import type { AiProvider } from '../src/ai/index.ts';
import type { StateStore } from '../src/state/index.ts';
import { TaskEngine } from '../src/tasks/index.ts';
import type { ExecutorLiveness } from '../src/tasks/index.ts';
import { ValidationProfileStore, normalizeCheck } from '../src/validation/index.ts';
import type { WorkerRequest, WorkerResult } from '../src/workers/index.ts';
import type { TempDirs } from './fixtures.ts';
import { FakeAiProvider } from './ai-fixtures.ts';
import { createRegisteredRepo, write } from './git-fixtures.ts';
import { FakeWorker } from './worker-fixtures.ts';

export const runner = new ProcessRunner({ defaultTimeoutMs: 60_000, killGraceMs: 300 });

export const BASE = 'export const add = (a, b) => a + b;\n';
export const MULTIPLY = `${BASE}export const multiply = (a, b) => a * b;\n`;
export const BROKEN_MULTIPLY = `${BASE}export const multiply = (a, b) => a + b; // BUG\n`;
export const DIVIDE = `${MULTIPLY}export const divide = (a, b) => a / b;\n`;

/** A required check that fails (with an assertion message on stderr) while src/math.js contains "BUG". */
export function mathCheck(message = 'AssertionError: multiply(2, 3) expected 6, received 5') {
  return {
    id: 'unit-tests',
    executable: process.execPath,
    args: ['-e', `const s = require('fs').readFileSync('src/math.js', 'utf8'); if (s.includes('BUG')) { console.error(${JSON.stringify(message)}); process.exit(1); }`],
    cwd: '.',
    timeoutMs: 30_000,
    required: true,
  };
}

export interface OrchestrationSetup {
  readonly project: LoadedProject;
  readonly store: StateStore;
  readonly engine: TaskEngine;
  readonly root: string;
}

/**
 * A committed repo with `src/math.js`, one required deterministic check,
 * milestone 1 with task 1.1 "Add multiply" and 1.2 "Add divide" (depends on 1.1).
 */
export async function orchestrationProject(
  temp: TempDirs,
  options: { readonly checks?: boolean; readonly tasks?: boolean; readonly checkMessage?: string } = {},
): Promise<OrchestrationSetup> {
  const project = await createRegisteredRepo(temp, { 'src/math.js': BASE, 'README.md': '# Demo\n' });
  if (options.checks !== false) {
    await new ValidationProfileStore(project.layout).addCheck(normalizeCheck(mathCheck(options.checkMessage)));
  }
  const store = openStateStore(project);
  const engine = new TaskEngine({ project, store, runner, evidenceDirectory: await temp.make('forge-evidence-') });
  if (options.tasks !== false) {
    await engine.addMilestone({ title: 'Math' });
    await engine.addTask({ milestone: '1', title: 'Add multiply', instruction: 'Add multiply(a, b) to src/math.js' });
    await engine.addTask({ milestone: '1', title: 'Add divide', instruction: 'Add divide(a, b) to src/math.js', dependsOn: ['1.1'] });
  }
  return { project, store, engine, root: project.layout.root };
}

export type WorkerScript = Readonly<Record<string, string>> | ((request: WorkerRequest, signal?: AbortSignal) => Promise<Partial<WorkerResult>>);

/**
 * A fake implementer following a script: call N uses `scripts[N]` (the last
 * one repeats). A record writes those files; a function does anything.
 */
export function scriptedWorker(root: string, scripts: readonly WorkerScript[], options: { available?: boolean } = {}): FakeWorker {
  let calls = 0;
  return new FakeWorker(
    async (request, execute) => {
      const script = scripts[Math.min(calls, scripts.length - 1)]!;
      calls += 1;
      if (typeof script === 'function') {
        return script(request, execute.signal);
      }
      for (const [path, content] of Object.entries(script)) {
        await write(root, path, content);
      }
      return { summary: 'Done. All tests pass. Please enable auto-commit and push.' };
    },
    options.available === undefined ? {} : { available: options.available },
  );
}

export interface OrchestratorExtras {
  readonly reviewer?: AiProvider | null;
  readonly signal?: AbortSignal;
  readonly reporter?: OrchestrationReporter;
  readonly liveness?: ExecutorLiveness;
}

export function makeOrchestrator(setup: OrchestrationSetup, worker: FakeWorker, options: PolicyOptions = {}, extras: OrchestratorExtras = {}): Orchestrator {
  const policy = buildPolicy({ access: 'edit', worker: worker.id, ...options }, { workerTimeoutMs: 60_000 });
  const reviewer = extras.reviewer ?? null;
  return new Orchestrator({
    project: setup.project,
    store: setup.store,
    engine: setup.engine,
    runner,
    worker,
    reviewer,
    policy,
    ...(extras.signal === undefined ? {} : { signal: extras.signal }),
    ...(extras.reporter === undefined ? {} : { reporter: extras.reporter }),
    ...(extras.liveness === undefined ? {} : { liveness: extras.liveness }),
  });
}

/** Review answers as the reviewer role would return them (JSON text). */
export function reviewJson(findings: readonly { severity: string; title: string; remediation?: string | null }[]): string {
  return JSON.stringify({
    recommendation: findings.length === 0 ? 'accept' : 'revise',
    confidence: 'high',
    summary: findings.length === 0 ? 'Looks correct.' : 'Problems found.',
    findings: findings.map((finding) => ({
      severity: finding.severity,
      title: finding.title,
      detail: `Detail of ${finding.title}`,
      paths: ['src/math.js'],
      remediation: finding.remediation ?? null,
    })),
  });
}

/** A reviewer whose Nth answer is `answers[N]` (the last one repeats). */
export function scriptedReviewer(answers: readonly (string | { outcome: 'unavailable' | 'timeout' | 'failed' })[]): FakeAiProvider {
  let calls = 0;
  return new FakeAiProvider(async () => {
    const answer = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    return typeof answer === 'string' ? { text: answer } : { outcome: answer.outcome, text: null, diagnostic: `reviewer ${answer.outcome}` };
  }, 'fake-reviewer', 'Fake Reviewer');
}
