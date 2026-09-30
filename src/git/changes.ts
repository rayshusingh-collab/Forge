import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { EVIDENCE_LIMITS } from '../state/index.ts';
import type { BaselineEntry, ChangeSummary, FileChange, FileChangeKind, GitBaseline } from '../state/index.ts';
import type { GitClient } from './client.ts';
import type { StatusEntry } from './status.ts';

/**
 * Baseline / delta attribution of working tree changes.
 *
 * A baseline records every path Git reports as changed (staged, unstaged,
 * or untracked) before a task, with a fingerprint of its working tree
 * content. After the task, the same is captured again and compared:
 * - a path clean before and changed after is attributed to the task;
 * - a path dirty before and unchanged after is pre-existing user work;
 * - a path dirty before and changed again is `mixed`: Forge knows it was
 *   touched, not which part is whose, and never claims otherwise.
 * Ignored files are invisible to this model (see README).
 */

export interface SnapshotEntry extends StatusEntry {
  readonly fingerprint: string;
  /** False for a path Git reports as clean (fingerprinted only because it was requested). */
  readonly dirty: boolean;
}

export interface WorktreeSnapshot {
  readonly head: string | null;
  readonly branch: string | null;
  readonly entries: ReadonlyMap<string, SnapshotEntry>;
}

const PROTECTED_PREFIXES = ['.forge', '.git'];

/** Content fingerprint of a working tree path; never reads outside `root`. */
export async function fingerprintPath(root: string, path: string): Promise<string> {
  const absolute = join(root, ...path.split('/'));
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return 'missing';
  }
  if (info.isSymbolicLink()) {
    return `link:${createHash('sha256').update(await readlink(absolute)).digest('hex')}`;
  }
  if (info.isDirectory()) {
    return 'dir';
  }
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(absolute)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return `sha256:${hash.digest('hex')}`;
}

/** Git status plus fingerprints of every reported path (and `extraPaths`, e.g. a baseline's). */
export async function takeSnapshot(git: GitClient, extraPaths: Iterable<string> = []): Promise<WorktreeSnapshot> {
  const status = await git.status();
  const entries = new Map<string, SnapshotEntry>();
  for (const entry of status.entries) {
    entries.set(entry.path, { ...entry, fingerprint: await fingerprintPath(git.root, entry.path), dirty: true });
  }
  // Requested paths that are clean now still get a fingerprint, so the delta
  // can tell "reverted to HEAD" apart from "unknown".
  for (const path of extraPaths) {
    if (!entries.has(path)) {
      entries.set(path, {
        path,
        origPath: null,
        kind: 'tracked',
        index: '.',
        worktree: '.',
        headHash: null,
        indexHash: null,
        fingerprint: await fingerprintPath(git.root, path),
        dirty: false,
      });
    }
  }
  return { head: status.head, branch: status.branch, entries };
}

function isClean(entry: SnapshotEntry | undefined): boolean {
  return entry === undefined || !entry.dirty;
}

/** The persisted (bounded) form of a snapshot, used as a task's baseline. */
export function toBaseline(snapshot: WorktreeSnapshot, now: Date): GitBaseline {
  const dirty = [...snapshot.entries.values()].filter((entry) => !isClean(entry)).sort((a, b) => compare(a.path, b.path));
  const storable = dirty.filter((entry) => entry.path.length <= EVIDENCE_LIMITS.path);
  const entries: BaselineEntry[] = storable.slice(0, EVIDENCE_LIMITS.baselineEntries).map((entry) => ({
    path: entry.path,
    index: entry.index,
    worktree: entry.worktree,
    indexHash: entry.indexHash,
    fingerprint: entry.fingerprint,
  }));
  return {
    head: snapshot.head,
    branch: snapshot.branch,
    entries,
    truncated: entries.length < dirty.length,
    capturedAt: now.toISOString(),
  };
}

/**
 * Baseline for a retry. Forge never reverts a failed attempt, so its edits
 * are still in the working tree when the next attempt starts; they belong to
 * the task, not to the user. The attempt's baseline is therefore derived
 * from the task's FIRST baseline and the previous attempt's recorded changes:
 * - a path whose content still matches what the task last recorded stays the
 *   task's (a `mixed` path stays mixed);
 * - a pre-existing path still as it was stays pre-existing;
 * - anything else that is dirty now cannot be explained (e.g. the user edited
 *   it between attempts) and is treated as pre-existing user work.
 * Falls back to a fresh baseline (everything dirty is pre-existing) when the
 * history cannot be trusted: no recorded changes for the previous attempt,
 * truncated evidence, or HEAD/branch moved since the task began.
 */
export function carryForwardBaseline(
  first: GitBaseline | null,
  previous: ChangeSummary | null,
  current: WorktreeSnapshot,
  now: Date,
): GitBaseline {
  const fresh = toBaseline(current, now);
  if (
    first === null ||
    previous === null ||
    first.truncated ||
    previous.truncated ||
    previous.baseline.truncated ||
    first.head !== current.head ||
    first.branch !== current.branch ||
    previous.head !== current.head
  ) {
    return fresh;
  }
  const original = new Map(first.entries.map((entry) => [entry.path, entry]));
  const recorded = new Map(previous.files.map((file) => [file.path, file]));
  const entries = new Map(original);

  for (const entry of current.entries.values()) {
    if (!entry.dirty) {
      continue;
    }
    const before = original.get(entry.path);
    const taskChange = recorded.get(entry.path);
    const stillAsTaskLeftIt = taskChange !== undefined && taskChange.fingerprint === entry.fingerprint;
    if (before !== undefined) {
      const untouched = before.fingerprint === entry.fingerprint && before.index === entry.index && before.worktree === entry.worktree;
      if (!(stillAsTaskLeftIt || untouched)) {
        entries.set(entry.path, fromSnapshotEntry(entry)); // Someone changed it between attempts.
      }
    } else if (!(stillAsTaskLeftIt && taskChange.attribution === 'task')) {
      entries.set(entry.path, fromSnapshotEntry(entry)); // Unexplained change: treat as the user's.
    }
  }

  const sorted = [...entries.values()].sort((a, b) => compare(a.path, b.path));
  const stored = sorted.slice(0, EVIDENCE_LIMITS.baselineEntries);
  return { head: current.head, branch: current.branch, entries: stored, truncated: stored.length < sorted.length, capturedAt: now.toISOString() };
}

function fromSnapshotEntry(entry: SnapshotEntry): BaselineEntry {
  return { path: entry.path, index: entry.index, worktree: entry.worktree, indexHash: entry.indexHash, fingerprint: entry.fingerprint };
}

/**
 * Compares the current working tree with `baseline`. `scope` is the task's
 * working directory relative to the root (`.` for the whole project).
 */
export async function captureChanges(git: GitClient, baseline: GitBaseline, scope: string, now: Date): Promise<ChangeSummary> {
  const after = await takeSnapshot(git, baseline.entries.map((entry) => entry.path));
  return computeChanges(baseline, after, scope, now);
}

export function computeChanges(baseline: GitBaseline, after: WorktreeSnapshot, scope: string, now: Date): ChangeSummary {
  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.entries.keys()])].sort(compare);

  const files: FileChange[] = [];
  const indexChanged: string[] = [];
  const outOfScope: string[] = [];
  let preexistingUntouched = 0;

  for (const path of paths) {
    const b = before.get(path);
    const a = after.entries.get(path);
    const aDirty = !isClean(a);

    if (b === undefined && !aDirty) {
      continue; // Clean before and after.
    }
    if (b !== undefined && a !== undefined && aDirty && sameState(b, a)) {
      preexistingUntouched++;
      continue;
    }
    if (b !== undefined && !aDirty && a?.fingerprint === b.fingerprint && b.index === '.') {
      // Stayed byte-identical; only reported clean now because of line-ending normalization etc.
      preexistingUntouched++;
      continue;
    }

    // Changed during the task. When the baseline is truncated, a path missing
    // from it may still have been dirty, so it cannot be attributed to the task.
    const attribution = b !== undefined || baseline.truncated ? 'mixed' : 'task';
    files.push({
      path,
      change: aDirty ? changeKind(a!) : 'modified',
      from: aDirty && a!.kind === 'renamed' ? a!.origPath : null,
      attribution,
      fingerprint: a?.fingerprint ?? 'missing',
    });

    if (indexDiffers(b, aDirty ? a : undefined)) {
      indexChanged.push(path);
    }
    if (!inScope(path, scope)) {
      outOfScope.push(path);
    }
  }

  return {
    baseline,
    head: after.head,
    branch: after.branch,
    files: files.slice(0, EVIDENCE_LIMITS.changedFiles),
    truncated: files.length > EVIDENCE_LIMITS.changedFiles || files.some((file) => file.path.length > EVIDENCE_LIMITS.path),
    preexistingUntouched,
    indexChanged: indexChanged.slice(0, EVIDENCE_LIMITS.pathList),
    outOfScope: outOfScope.slice(0, EVIDENCE_LIMITS.pathList),
    capturedAt: now.toISOString(),
  };
}

/** True when a path is inside the task's working directory and not a protected control path. */
export function inScope(path: string, scope: string): boolean {
  const top = path.split('/')[0]!.toLowerCase();
  if (PROTECTED_PREFIXES.includes(top)) {
    return false;
  }
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

function changeKind(entry: SnapshotEntry): FileChangeKind {
  if (entry.kind === 'untracked' || entry.index === 'A') {
    return 'added';
  }
  if (entry.kind === 'renamed') {
    return 'renamed';
  }
  if (entry.index === 'D' || entry.worktree === 'D') {
    return 'deleted';
  }
  return 'modified';
}

function sameState(b: BaselineEntry, a: SnapshotEntry): boolean {
  return b.fingerprint === a.fingerprint && b.index === a.index && b.worktree === a.worktree && b.indexHash === a.indexHash;
}

/** Whether the staged (index) side of a path changed between baseline and now. */
function indexDiffers(b: BaselineEntry | undefined, a: SnapshotEntry | undefined): boolean {
  const beforeIndex = b === undefined || b.index === '?' ? '.' : b.index;
  const afterIndex = a === undefined || a.index === '?' ? '.' : a.index;
  const hashChanged = (b?.indexHash ?? null) !== (a?.indexHash ?? null);
  return beforeIndex !== afterIndex || (hashChanged && (beforeIndex !== '.' || afterIndex !== '.'));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
