import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { assertProcessSucceeded } from '../src/execution/index.ts';
import { registerProject } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { TempDirs, initGitRepo, testRunner } from './fixtures.ts';

/**
 * Temporary repositories for Git-safety and validation tests. Identity and
 * signing are configured per temporary repository only (never globally).
 */

export async function git(root: string, ...args: string[]): Promise<string> {
  const result = await testRunner.run({ command: 'git', args, cwd: root, env: { GIT_TERMINAL_PROMPT: '0' } });
  assertProcessSucceeded(result);
  return result.stdout;
}

export async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

/** A repository with `files` committed as the initial commit (or no commit when `commit` is false). */
export async function createRepo(
  temp: TempDirs,
  files: Readonly<Record<string, string>> = { 'README.md': '# Demo\n' },
  options: { readonly commit?: boolean; readonly name?: string } = {},
): Promise<string> {
  const root = await initGitRepo(join(await temp.make('forge-git-'), options.name ?? 'repo'));
  await git(root, 'config', 'user.name', 'Forge Test');
  await git(root, 'config', 'user.email', 'forge-test@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'config', 'core.autocrlf', 'false');
  for (const [path, content] of Object.entries(files)) {
    await write(root, path, content);
  }
  if (options.commit !== false) {
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'initial');
  }
  return root;
}

export async function createRegisteredRepo(
  temp: TempDirs,
  files?: Readonly<Record<string, string>>,
  options?: { readonly commit?: boolean },
): Promise<LoadedProject> {
  const root = await createRepo(temp, files, options);
  return registerProject({ path: root, cwd: root, runner: testRunner });
}

/** A node -e script check that passes when `expression` is truthy (evaluated in the project root). */
export function nodeCheck(id: string, expression: string, extra: { required?: boolean; timeoutMs?: number } = {}) {
  return {
    id,
    executable: process.execPath,
    args: ['-e', `process.exit((${expression}) ? 0 : 1)`],
    cwd: '.',
    timeoutMs: extra.timeoutMs ?? 30_000,
    required: extra.required ?? true,
  };
}
