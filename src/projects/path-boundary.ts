import { lstat, realpath } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { PlatformPath } from 'node:path';

import { AuthorizationError } from '../core/errors.ts';

/**
 * Project path boundary: decides whether a requested path lies inside an
 * authorized project root. Later systems must call this before any
 * filesystem or process operation on a project path.
 *
 * Two layers:
 * 1. Lexical (`resolve` / `contains`): the path is made absolute against the
 *    root, normalized (separators, `.`, `..`), and compared with
 *    `path.relative`, never with a string-prefix check, so `C:\project` does
 *    not contain `C:\project-evil`. Windows comparisons are case-insensitive.
 * 2. Physical (`authorize`): the deepest existing part of the path is
 *    resolved with `realpath`, so a symlink or junction inside the project
 *    that points outside it is rejected.
 *
 * Limitations (see README): components that do not exist yet cannot be
 * resolved, and nothing prevents a link from being created between the check
 * and the eventual use (time-of-check/time-of-use).
 */

export interface PathRules {
  readonly path: PlatformPath;
  readonly windows: boolean;
}

export const WINDOWS_PATH_RULES: PathRules = { path: win32, windows: true };
export const POSIX_PATH_RULES: PathRules = { path: posix, windows: false };
export const HOST_PATH_RULES: PathRules = process.platform === 'win32' ? WINDOWS_PATH_RULES : POSIX_PATH_RULES;

/**
 * Win32 device names that refer to devices, not files, in any directory —
 * including with an extension or trailing dots/spaces (`nul.txt`, `con `).
 */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])([ .].*)?$/i;

export interface AuthorizedPath {
  /** Absolute, normalized path as requested. */
  readonly path: string;
  /** Path relative to the project root; `''` for the root itself. */
  readonly relativePath: string;
  /** Path with existing links resolved (non-existing tail appended). */
  readonly resolvedPath: string;
  readonly exists: boolean;
}

/** True when `candidate` is `root` or inside it. Both must be absolute. */
export function isWithin(root: string, candidate: string, rules: PathRules = HOST_PATH_RULES): boolean {
  const relative = rules.path.relative(root, candidate);
  return isInsideRelative(relative, rules);
}

/** Path equality under the platform's rules (case-insensitive on Windows). */
export function pathsEqual(a: string, b: string, rules: PathRules = HOST_PATH_RULES): boolean {
  return rules.path.relative(a, b) === '';
}

function isInsideRelative(relative: string, rules: PathRules): boolean {
  // win32.relative compares case-insensitively and returns an absolute path
  // when the drives or UNC shares differ.
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${rules.path.sep}`) && !rules.path.isAbsolute(relative))
  );
}

export class ProjectPathBoundary {
  /** Absolute, normalized project root. The root itself is inside the boundary. */
  readonly root: string;
  private readonly rules: PathRules;

  constructor(root: string, rules: PathRules = HOST_PATH_RULES) {
    if (!rules.path.isAbsolute(root)) {
      throw new AuthorizationError('Project root must be an absolute path', { details: { root } });
    }
    this.rules = rules;
    this.root = rules.path.resolve(root);
  }

  /** Lexical check without throwing. */
  contains(requested: string): boolean {
    try {
      this.resolve(requested);
      return true;
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Resolves `requested` (absolute, or relative to the root) and verifies it
   * is lexically inside the root. Returns the absolute normalized path.
   */
  resolve(requested: string): string {
    this.rejectUnsafeSyntax(requested);
    const candidate = this.rules.path.resolve(this.root, requested);
    const relative = this.rules.path.relative(this.root, candidate);
    if (!isInsideRelative(relative, this.rules)) {
      throw new AuthorizationError('Path is outside the project root', {
        details: { root: this.root, requested },
      });
    }
    if (this.rules.windows) {
      this.rejectWindowsSpecialNames(relative, requested);
    }
    return candidate;
  }

  /**
   * Full check for use before touching the filesystem: lexical containment,
   * then link resolution of the deepest existing ancestor. Must only be used
   * with the host platform's rules.
   */
  async authorize(requested: string): Promise<AuthorizedPath> {
    if (this.rules !== HOST_PATH_RULES) {
      throw new AuthorizationError('Filesystem authorization requires host path rules');
    }
    const candidate = this.resolve(requested);
    const relativePath = this.rules.path.relative(this.root, candidate);

    const existing = await this.deepestExisting(candidate, requested);
    let realRoot: string;
    let realExisting: string;
    try {
      realRoot = await realpath(this.root);
      realExisting = await realpath(existing);
    } catch (error) {
      throw new AuthorizationError('Path cannot be resolved (broken link or inaccessible)', {
        details: { root: this.root, requested },
        cause: error,
      });
    }
    if (!isWithin(realRoot, realExisting, this.rules)) {
      throw new AuthorizationError('Path resolves outside the project root through a symbolic link or junction', {
        details: { root: this.root, requested },
      });
    }

    const tail = this.rules.path.relative(existing, candidate);
    return {
      path: candidate,
      relativePath,
      resolvedPath: tail === '' ? realExisting : this.rules.path.join(realExisting, tail),
      exists: existing === candidate,
    };
  }

  private async deepestExisting(candidate: string, requested: string): Promise<string> {
    let current = candidate;
    for (;;) {
      try {
        await lstat(current);
        return current;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new AuthorizationError('Path cannot be inspected', { details: { requested }, cause: error });
        }
      }
      if (pathsEqual(current, this.root, this.rules)) {
        throw new AuthorizationError('Project root does not exist', { details: { root: this.root } });
      }
      current = this.rules.path.dirname(current);
    }
  }

  private rejectUnsafeSyntax(requested: string): void {
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new AuthorizationError('Path must be a non-empty string');
    }
    if (requested.includes('\0')) {
      throw new AuthorizationError('Path must not contain NUL characters');
    }
    if (this.rules.windows && /^[\\/]{2}[?.][\\/]/.test(requested)) {
      // \\?\ and \\.\ bypass Win32 path normalization and reach devices.
      throw new AuthorizationError('Windows device and namespace paths are not allowed', { details: { requested } });
    }
  }

  private rejectWindowsSpecialNames(relative: string, requested: string): void {
    for (const segment of relative.split(this.rules.path.sep)) {
      if (segment.includes(':')) {
        // Alternate data streams (`file:stream`) and drive-relative forms.
        throw new AuthorizationError('Path segments must not contain ":"', { details: { requested } });
      }
      if (WINDOWS_RESERVED_NAME.test(segment)) {
        throw new AuthorizationError(`"${segment}" is a reserved Windows device name`, { details: { requested } });
      }
    }
  }
}
