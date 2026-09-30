import type { AiProvider, AiProviderRegistry, AiRequest, AiResponse } from '../src/ai/index.ts';
import type { WorkerHealth } from '../src/workers/index.ts';

/** A scripted AI provider: records every request, answers with the given text or outcome. */
export class FakeAiProvider implements AiProvider {
  readonly id: string;
  readonly displayName: string;
  readonly requests: AiRequest[] = [];
  private readonly answer: (request: AiRequest, signal?: AbortSignal) => Promise<Partial<AiResponse>>;

  constructor(answer: (request: AiRequest, signal?: AbortSignal) => Promise<Partial<AiResponse>>, id = 'fake-ai', displayName = 'Fake AI') {
    this.answer = answer;
    this.id = id;
    this.displayName = displayName;
  }

  static answering(text: string, id?: string): FakeAiProvider {
    return new FakeAiProvider(async () => ({ text }), id);
  }

  async healthCheck(): Promise<WorkerHealth> {
    return { workerId: this.id, available: true, version: '1.0.0', executable: '/fake', authenticated: true, checks: [] };
  }

  async complete(request: AiRequest, options: { readonly signal?: AbortSignal } = {}): Promise<AiResponse> {
    this.requests.push(request);
    const partial = await this.answer(request, options.signal);
    return {
      outcome: 'success',
      text: null,
      call: { provider: this.id, model: 'fake-model', durationMs: 12, costUsd: 0.001, inputTokens: 100, outputTokens: 50 },
      diagnostic: null,
      ...partial,
    };
  }
}

export function aiRegistry(...providers: AiProvider[]): AiProviderRegistry {
  return {
    list: () => providers.map((provider) => ({ id: provider.id, aliases: [], displayName: provider.displayName })),
    create: (name) => providers.find((provider) => provider.id === name),
  };
}

/** A small valid plan: m1 with t1, t2 (after t1); m2 with t3 (after t2). */
export function samplePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'Add subtraction with tests',
    assumptions: ['Node test runner is used'],
    milestones: [
      { id: 'm1', title: 'Subtraction', description: null },
      { id: 'm2', title: 'Docs', description: 'Document it' },
    ],
    tasks: [
      { id: 't1', milestone: 'm1', title: 'Add subtract', instruction: 'Add subtract(a,b) to src/math.js', context: null, dependsOn: [], suggestedValidation: ['unit tests'] },
      { id: 't2', milestone: 'm1', title: 'Test subtract', instruction: 'Add tests for subtract', context: null, dependsOn: ['t1'], suggestedValidation: [] },
      { id: 't3', milestone: 'm2', title: 'Document subtract', instruction: 'Mention subtract in README', context: null, dependsOn: ['t2'], suggestedValidation: [] },
    ],
    risks: ['Floating point edge cases'],
    notes: null,
    ...overrides,
  };
}

export function sampleReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recommendation: 'revise',
    confidence: 'medium',
    summary: 'Works, but an edge case is untested.',
    findings: [
      { severity: 'warning', title: 'Missing negative-number test', detail: 'No test covers negative inputs.', paths: ['tests/math.test.js'], remediation: 'Add a test for subtract(-1, -2).' },
    ],
    ...overrides,
  };
}
