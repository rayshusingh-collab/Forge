import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProcessRunner, assertProcessSucceeded } from '../src/execution/index.ts';

/**
 * Filesystem fixtures for project/state tests. Everything is created under
 * the OS temp directory; the Forge repository itself is never used.
 */

export const testRunner = new ProcessRunner({ defaultTimeoutMs: 30_000 });

/** Tracks temp directories so a test file can remove them all in `after`. */
export class TempDirs {
  private readonly created: string[] = [];

  /** Returns the canonical (realpath) form, e.g. resolving /var -> /private/var on macOS. */
  async make(prefix = 'forge-test-'): Promise<string> {
    const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    this.created.push(dir);
    return dir;
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.created.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })));
    this.created.length = 0;
  }
}

/** Initializes a Git repository in `dir` (creating it if needed). */
export async function initGitRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  assertProcessSucceeded(await testRunner.run({ command: 'git', args: ['init', '--quiet'], cwd: dir }));
  return dir;
}

export async function gitStatusPorcelain(dir: string): Promise<string> {
  const result = await testRunner.run({ command: 'git', args: ['status', '--porcelain'], cwd: dir });
  assertProcessSucceeded(result);
  return result.stdout;
}

/**
 * Creates a directory link: a junction on Windows (no privileges required),
 * a symlink elsewhere. Returns false only when the OS refuses for permission
 * reasons, so callers can skip rather than fail.
 */
export async function tryLinkDirectory(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return false;
    }
    throw error;
  }
}

/** File symlinks need Developer Mode or admin rights on Windows. */
export async function tryLinkFile(target: string, link: string): Promise<boolean> {
  try {
    await symlink(target, link, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return false;
    }
    throw error;
  }
}
