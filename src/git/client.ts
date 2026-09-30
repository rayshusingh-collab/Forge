import { GitError } from '../core/errors.ts';
import { resolveExecutable } from '../execution/index.ts';
import type { ProcessExecutor, ProcessResult, ResolvedExecutable } from '../execution/index.ts';
import { parsePorcelainV2 } from './status.ts';
import type { GitStatus } from './status.ts';

/**
 * Forge's Git safety layer: the only way Forge runs Git.
 *
 * - Git is resolved to an absolute program (never looked up in the project).
 * - Arguments are arrays, never shell text; paths always follow `--` and are
 *   literal (`GIT_LITERAL_PATHSPECS=1`), so names like `*` or `:(top)` are
 *   never interpreted as patterns.
 * - Output is machine-readable (`-z`, porcelain v2) and size-bounded.
 * - Only non-destructive operations exist here. There is deliberately no
 *   push, reset, clean, checkout, stash, rebase, merge, amend, or branch
 *   deletion. Index changes are limited to adding explicit new files,
 *   removing index entries Forge itself added, and `commit --only`.
 */

const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
} as const;

const MAX_STATUS_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

export interface GitClientOptions {
  readonly runner: ProcessExecutor;
  /** Repository root (canonical absolute path); every command runs here. */
  readonly root: string;
  /** Git program name or absolute path; resolved safely. Defaults to `git`. */
  readonly git?: string;
}

export class GitClient {
  private readonly runner: ProcessExecutor;
  private readonly executable: ResolvedExecutable;
  readonly root: string;

  private constructor(runner: ProcessExecutor, executable: ResolvedExecutable, root: string) {
    this.runner = runner;
    this.executable = executable;
    this.root = root;
  }

  static async create(options: GitClientOptions): Promise<GitClient> {
    const resolution = await resolveExecutable(options.git ?? 'git');
    if (!resolution.ok) {
      throw new GitError(`Git is not available: ${resolution.message}`);
    }
    return new GitClient(options.runner, resolution.executable, options.root);
  }

  /** Working tree status, including untracked files (ignored files are excluded). */
  async status(): Promise<GitStatus> {
    const result = await this.run(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
      maxOutputBytes: MAX_STATUS_BYTES,
    });
    if (result.stdoutTruncated) {
      throw new GitError('git status output exceeded the capture limit; refusing to act on partial information');
    }
    return parsePorcelainV2(result.stdout);
  }

  /**
   * Tracked files plus untracked files that are NOT ignored (Git's own
   * `.gitignore` rules). Ignored files, such as `.env`, are never listed.
   */
  async listFiles(): Promise<string[]> {
    const result = await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--full-name'], {
      maxOutputBytes: MAX_STATUS_BYTES,
    });
    if (result.stdoutTruncated) {
      throw new GitError('git ls-files output exceeded the capture limit');
    }
    return [...new Set(result.stdout.split('\0').filter((path) => path !== ''))].sort();
  }

  /**
   * Unified diff of one path between `commit` and the working tree
   * (read-only; external diff tools and text conversion are disabled).
   */
  async diffPath(commit: string, path: string, maxBytes: number): Promise<{ readonly text: string; readonly truncated: boolean }> {
    const result = await this.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', commit, '--', path], {
      maxOutputBytes: maxBytes,
    });
    return { text: result.stdout, truncated: result.stdoutTruncated };
  }

  /** Stages explicit new files. Paths are literal and follow `--`. */
  async addPaths(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) {
      await this.run(['add', '--', ...paths], { readOnly: false });
    }
  }

  /** Removes index entries (never working tree files), e.g. to undo Forge's own staging. */
  async unstageNewPaths(paths: readonly string[]): Promise<void> {
    if (paths.length > 0) {
      await this.run(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...paths], { readOnly: false });
    }
  }

  /**
   * Commits exactly `paths` with their working tree content (`--only`),
   * leaving anything else staged by the user untouched and uncommitted.
   * The message is passed on stdin. Repository hooks run as for any commit.
   */
  async commitOnly(paths: readonly string[], message: string): Promise<string> {
    if (paths.length === 0) {
      throw new GitError('Refusing to create an empty commit');
    }
    await this.run(['commit', '--only', '--quiet', '--no-edit', '-F', '-', '--', ...paths], {
      input: message,
      readOnly: false,
    });
    const head = (await this.run(['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) {
      throw new GitError('Could not read the new commit hash');
    }
    return head;
  }

  /** Paths changed by a commit (relative, `/`-separated). Works for root commits. */
  async commitPaths(commit: string): Promise<string[]> {
    const result = await this.run(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', commit]);
    return result.stdout.split('\0').filter((path) => path !== '');
  }

  /** First parent of a commit, or null for a root commit. */
  async parentOf(commit: string): Promise<string | null> {
    const result = await this.run(['rev-list', '--parents', '-n', '1', commit]);
    const [, parent] = result.stdout.trim().split(' ');
    return parent ?? null;
  }

  private async run(
    args: readonly string[],
    options: { input?: string; maxOutputBytes?: number; readOnly?: boolean } = {},
  ): Promise<ProcessResult> {
    const env: Record<string, string> = { ...BASE_ENV };
    if (options.readOnly === false) {
      // Writes must take Git's normal locks.
      delete env['GIT_OPTIONAL_LOCKS'];
    }
    const result = await this.runner.run({
      command: this.executable.command,
      args: [...this.executable.prefixArgs, '-c', 'color.ui=false', '-c', 'core.quotepath=false', ...args],
      cwd: this.root,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
      ...(options.input === undefined ? {} : { input: options.input }),
    });
    if (result.outcome !== 'success') {
      const detail = result.stderr.trim().split(/\r?\n/).filter((line) => !line.startsWith('warning:')).slice(0, 3).join(' ');
      throw new GitError(`git ${args[0]} failed (${result.outcome}${result.exitCode === null ? '' : ` ${result.exitCode}`}): ${detail}`, {
        details: { args: args.slice(0, 6) },
      });
    }
    return result;
  }
}
