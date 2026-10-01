import type { AiCallMetadata } from '../state/index.ts';
import type { WorkerHealth } from '../workers/index.ts';

/**
 * Provider-independent AI roles. A role (planner, reviewer, decision-maker) is Forge code
 * that builds a request, calls whichever provider is selected, and
 * validates the answer. A provider only turns text into text; it never
 * sees Forge state, never touches the project, and its answer is untrusted
 * until the role has validated it.
 */

export type AiRole = 'planner' | 'reviewer' | 'decision-maker';

export interface AiRequest {
  readonly role: AiRole;
  readonly requestId: string;
  /** Forge's fixed rules for the role (system-level). */
  readonly instructions: string;
  /** The fenced data: goal/task, project context, required output schema. */
  readonly input: string;
  readonly timeoutMs: number;
}

export type AiOutcome = 'success' | 'failed' | 'timeout' | 'cancelled' | 'unavailable' | 'invalid-output';

export interface AiResponse {
  readonly outcome: AiOutcome;
  /** The model's raw answer text (only for `success`). Untrusted. */
  readonly text: string | null;
  readonly call: AiCallMetadata;
  readonly diagnostic: string | null;
}

export interface AiProvider {
  /** Stable identifier recorded with every plan and review, e.g. `claude-code`. */
  readonly id: string;
  readonly displayName: string;
  healthCheck(): Promise<WorkerHealth>;
  /** Resolves for every outcome; never throws for provider failures. */
  complete(request: AiRequest, options?: { readonly signal?: AbortSignal }): Promise<AiResponse>;
}

export interface AiProviderDescriptor {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly displayName: string;
}

/** Selects providers per role invocation; roles and providers are independent. */
export interface AiProviderRegistry {
  list(): readonly AiProviderDescriptor[];
  create(nameOrAlias: string): AiProvider | undefined;
}

/** Hard cap on an AI answer. Larger answers are rejected, never truncated. */
export const MAX_AI_OUTPUT_CHARACTERS = 200_000;
