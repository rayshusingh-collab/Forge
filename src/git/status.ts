import { GitError } from '../core/errors.ts';

/**
 * Parser for `git status --porcelain=v2 -z --branch --untracked-files=all`.
 * Machine-readable output only; human/colored output is never parsed.
 */

export type StatusEntryKind = 'tracked' | 'renamed' | 'unmerged' | 'untracked';

export interface StatusEntry {
  /** Repository-relative path with `/` separators. */
  readonly path: string;
  /** Source path of a staged rename or copy. */
  readonly origPath: string | null;
  readonly kind: StatusEntryKind;
  /** Index (staged) status letter; `.` = unchanged, `?` for untracked. */
  readonly index: string;
  /** Worktree (unstaged) status letter; `.` = unchanged, `?` for untracked. */
  readonly worktree: string;
  readonly headHash: string | null;
  readonly indexHash: string | null;
}

export interface GitStatus {
  /** Commit HEAD points to; null in a repository with no commits yet. */
  readonly head: string | null;
  /** Current branch; null when HEAD is detached. */
  readonly branch: string | null;
  readonly entries: readonly StatusEntry[];
}

const ZERO_HASH = /^0+$/;

export function parsePorcelainV2(output: string): GitStatus {
  const tokens = output.split('\0');
  let head: string | null | undefined;
  let branch: string | null | undefined;
  const entries: StatusEntry[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '') {
      continue;
    }
    if (token.startsWith('# ')) {
      const [, key, ...rest] = token.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') {
        head = value === '(initial)' ? null : value;
      } else if (key === 'branch.head') {
        branch = value === '(detached)' ? null : value;
      }
      continue;
    }
    switch (token[0]) {
      case '1': {
        const fields = splitFields(token, 8);
        entries.push(entry('tracked', fields, null));
        break;
      }
      case '2': {
        const fields = splitFields(token, 9);
        const origPath = tokens[++index];
        if (origPath === undefined || origPath === '') {
          throw new GitError('Malformed git status output: rename without original path');
        }
        entries.push(entry('renamed', fields, origPath));
        break;
      }
      case 'u': {
        const fields = splitFields(token, 10);
        const xy = fields[1]!;
        entries.push({
          path: fields[10]!,
          origPath: null,
          kind: 'unmerged',
          index: xy[0]!,
          worktree: xy[1]!,
          headHash: null,
          indexHash: null,
        });
        break;
      }
      case '?':
        entries.push({ path: token.slice(2), origPath: null, kind: 'untracked', index: '?', worktree: '?', headHash: null, indexHash: null });
        break;
      case '!':
        break; // Ignored files are not requested; skip defensively.
      default:
        throw new GitError(`Malformed git status output: unexpected entry "${token.slice(0, 40)}"`);
    }
  }

  if (head === undefined || branch === undefined) {
    throw new GitError('Malformed git status output: missing branch header');
  }
  return { head, branch, entries };
}

/** Splits `count` space-separated fields; the remainder (a path, which may contain spaces) is field `count`. */
function splitFields(token: string, count: number): string[] {
  const fields: string[] = [];
  let rest = token;
  for (let field = 0; field < count; field++) {
    const space = rest.indexOf(' ');
    if (space === -1) {
      throw new GitError(`Malformed git status output: "${token.slice(0, 40)}"`);
    }
    fields.push(rest.slice(0, space));
    rest = rest.slice(space + 1);
  }
  fields.push(rest);
  return fields;
}

function entry(kind: 'tracked' | 'renamed', fields: string[], origPath: string | null): StatusEntry {
  const xy = fields[1]!;
  const hash = (value: string | undefined): string | null => (value === undefined || ZERO_HASH.test(value) ? null : value);
  return {
    path: fields[fields.length - 1]!,
    origPath,
    kind,
    index: xy[0]!,
    worktree: xy[1]!,
    headHash: hash(fields[6]),
    indexHash: hash(fields[7]),
  };
}
