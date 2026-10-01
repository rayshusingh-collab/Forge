import type { ForgeConfig } from '../config/index.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import type { Logger } from '../logging/index.ts';
import { ClaudeCodeAiProvider } from './claude-provider.ts';
import { CodexAiProvider } from './codex-provider.ts';
import type { AiProvider, AiProviderDescriptor, AiProviderRegistry } from './types.ts';

export interface AiProviderRegistryDependencies {
  readonly config: ForgeConfig;
  readonly runner: ProcessExecutor;
  readonly logger: Logger;
}

const BUILT_IN: readonly (AiProviderDescriptor & { readonly create: (deps: AiProviderRegistryDependencies) => AiProvider })[] = [
  {
    id: 'claude-code',
    aliases: ['claude'],
    displayName: 'Claude Code',
    create: ({ config, runner, logger }) => new ClaudeCodeAiProvider({ runner, executable: config.claudeExecutable, logger }),
  },
  {
    id: 'codex',
    aliases: ['codex-cli'],
    displayName: 'Codex CLI',
    create: ({ config, runner, logger }) => new CodexAiProvider({ runner, executable: config.codexExecutable, logger }),
  },
];

/**
 * Providers available to AI roles. The planner and reviewer are chosen per
 * invocation (`--planner`, `--reviewer`) or by project configuration and
 * recorded by provider ID; any provider can plan or review while another
 * implements. There is no fallback: an unknown or unavailable provider is
 * reported, never silently replaced.
 */
export function createAiProviderRegistry(dependencies: AiProviderRegistryDependencies): AiProviderRegistry {
  return {
    list: () => BUILT_IN.map(({ id, aliases, displayName }) => ({ id, aliases, displayName })),
    create: (nameOrAlias) => {
      const name = nameOrAlias.trim().toLowerCase();
      return BUILT_IN.find((entry) => entry.id === name || entry.aliases.includes(name))?.create(dependencies);
    },
  };
}
