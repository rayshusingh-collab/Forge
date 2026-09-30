import type { ForgeConfig } from '../config/index.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import type { Logger } from '../logging/index.ts';
import { CLAUDE_CODE_WORKER_ID, ClaudeCodeWorker } from './claude-code/worker.ts';
import type { Worker } from './types.ts';

export interface WorkerDescriptor {
  readonly id: string;
  /** Short names accepted on the command line, e.g. `claude`. */
  readonly aliases: readonly string[];
  readonly displayName: string;
}

/** Looks workers up by ID or alias and creates them on demand. */
export interface WorkerRegistry {
  list(): readonly WorkerDescriptor[];
  /** Returns undefined for unknown names; never throws. */
  create(nameOrAlias: string): Worker | undefined;
}

export interface WorkerRegistryDependencies {
  readonly config: ForgeConfig;
  readonly runner: ProcessExecutor;
  readonly logger: Logger;
}

type WorkerFactory = (dependencies: WorkerRegistryDependencies) => Worker;

const BUILT_IN: readonly (WorkerDescriptor & { readonly factory: WorkerFactory })[] = [
  {
    id: CLAUDE_CODE_WORKER_ID,
    aliases: ['claude'],
    displayName: 'Claude Code',
    factory: ({ config, runner, logger }) =>
      new ClaudeCodeWorker({ runner, executable: config.claudeExecutable, logger }),
  },
];

export function createWorkerRegistry(dependencies: WorkerRegistryDependencies): WorkerRegistry {
  return {
    list: () => BUILT_IN.map(({ id, aliases, displayName }) => ({ id, aliases, displayName })),
    create: (nameOrAlias) => {
      const name = nameOrAlias.trim().toLowerCase();
      const entry = BUILT_IN.find((candidate) => candidate.id === name || candidate.aliases.includes(name));
      return entry?.factory(dependencies);
    },
  };
}
