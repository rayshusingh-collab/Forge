import { resolve } from 'node:path';

import { ProjectError } from '../core/errors.ts';
import type { ProcessRunner } from '../execution/index.ts';

export const DEFAULT_GIT_EXECUTABLE = 'git';

/** Read-only Git commands should never block on or write index locks. */
const READ_ONLY_GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } as const;

/**
 * Returns the absolute root of the Git work tree containing `directory`.
 * Uses `git rev-parse --show-toplevel`, which is read-only: it does not
 * modify the repository, its config, or its index.
 */
export async function findGitWorkTreeRoot(
  runner: ProcessRunner,
  directory: string,
  gitExecutable: string = DEFAULT_GIT_EXECUTABLE,
): Promise<string> {
  const result = await runner.run({
    command: gitExecutable,
    args: ['rev-parse', '--show-toplevel'],
    cwd: directory,
    env: READ_ONLY_GIT_ENV,
  });

  switch (result.outcome) {
    case 'success': {
      const topLevel = result.stdout.trim();
      if (topLevel === '') {
        throw new ProjectError(`${directory} is not inside a Git work tree`, { details: { directory } });
      }
      // Git reports forward slashes on Windows; resolve() normalizes them.
      return resolve(topLevel);
    }
    case 'spawn-error':
      throw new ProjectError(
        `Git could not be started (${result.spawnError?.code ?? 'unknown error'}); is Git installed and on PATH?`,
        { details: { gitExecutable } },
      );
    case 'non-zero-exit':
      throw new ProjectError(`${directory} is not a Git work tree: ${firstLine(result.stderr)}`, {
        details: { directory, exitCode: result.exitCode },
      });
    case 'timeout':
    case 'cancelled':
      throw new ProjectError(`Git did not respond while inspecting ${directory} (${result.outcome})`, {
        details: { directory },
      });
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}
