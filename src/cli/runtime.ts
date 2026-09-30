import { DEFAULT_CONFIG, loadConfig } from '../config/index.ts';
import type { ForgeConfig } from '../config/index.ts';
import { ProcessRunner } from '../execution/index.ts';
import { createAiProviderRegistry } from '../ai/index.ts';
import type { AiProvider, AiProviderRegistry } from '../ai/index.ts';
import { createWorkerRegistry } from '../workers/index.ts';
import type { WorkerRegistry } from '../workers/index.ts';
import type { CliContext } from './types.ts';

/** Loads configuration for commands that require it; throws `ConfigurationError`. */
export function requireConfig(context: CliContext): ForgeConfig {
  return loadConfig(context.env);
}

/** Configuration, falling back to defaults when invalid (for commands that must still work). */
export function lenientConfig(context: CliContext): ForgeConfig {
  try {
    return loadConfig(context.env);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function createRunner(context: CliContext, config: ForgeConfig): ProcessRunner {
  return new ProcessRunner({ defaultTimeoutMs: config.processTimeoutMs, logger: context.logger });
}

/**
 * The injected registry, or the built-in one. `lenient` falls back to default
 * configuration when the environment is invalid (used by `doctor`, which
 * reports configuration problems separately).
 */
export function resolveWorkers(context: CliContext, options: { lenient?: boolean } = {}): WorkerRegistry {
  if (context.workers !== undefined) {
    return context.workers;
  }
  let config: ForgeConfig;
  try {
    config = loadConfig(context.env);
  } catch (error) {
    if (options.lenient !== true) {
      throw error;
    }
    config = DEFAULT_CONFIG;
  }
  return createWorkerRegistry({ config, runner: createRunner(context, config), logger: context.logger });
}

export function resolveAiProviders(context: CliContext): AiProviderRegistry {
  if (context.aiProviders !== undefined) {
    return context.aiProviders;
  }
  const config = lenientConfig(context);
  return createAiProviderRegistry({ config, runner: createRunner(context, config), logger: context.logger });
}

/** The named provider for an AI role, or undefined after explaining on stderr. */
export function createAiProvider(name: string, role: string, context: CliContext): AiProvider | undefined {
  const registry = resolveAiProviders(context);
  const provider = registry.create(name);
  if (provider === undefined) {
    const known = registry.list().flatMap((entry) => [entry.id, ...entry.aliases]);
    context.stderr.write(`forge: unknown ${role} "${name}" (available: ${known.join(', ')})\n`);
  }
  return provider;
}
