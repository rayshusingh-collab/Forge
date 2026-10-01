import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { loadProject, openStateStore } from './metadata.ts';
import type { LoadedProject } from './metadata.ts';
import type { ForgeLayout } from './layout.ts';

/**
 * Integrity guard for Forge control state (`.forge/`).
 *
 * `.forge/` belongs to Forge, not to workers. Around a worker run Forge takes
 * a snapshot and verifies it afterwards:
 *
 * - `full` scope (edit-enabled runs): every entry under `.forge/` — metadata,
 *   state, the state lock, stray temp files — must be byte-identical. This is
 *   sound only because the caller holds the state lease for the whole run, so
 *   no legitimate Forge write can happen in between: any difference was made
 *   by something other than Forge.
 * - `metadata` scope (read-only runs): only files that never change during a
 *   run (`project.json`, `.gitignore`, `validation.json`, `config.json`) are compared; state may legitimately
 *   be updated by other Forge processes meanwhile.
 *
 * Verification never repairs anything: changed files are left exactly as
 * found, as evidence.
 */

export type ControlSnapshotScope = 'full' | 'metadata';

export type EntryKind = 'file' | 'directory' | 'link' | 'other' | 'unreadable';

export interface EntryFingerprint {
  readonly kind: EntryKind;
  readonly size: number;
  /** SHA-256 of the content, for regular files. */
  readonly sha256: string | null;
}

export interface ControlSnapshot {
  readonly scope: ControlSnapshotScope;
  readonly forgeDir: string;
  readonly takenAt: string;
  /** Keyed by path relative to `.forge/` using `/`; `.` is `.forge/` itself. */
  readonly entries: ReadonlyMap<string, EntryFingerprint>;
  /** Original bytes of small files, kept only to preserve evidence. */
  readonly contents: ReadonlyMap<string, Buffer>;
}

export interface IntegrityChange {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'modified';
  readonly before: EntryFingerprint | null;
  readonly after: EntryFingerprint | null;
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly scope: ControlSnapshotScope;
  readonly changes: readonly IntegrityChange[];
  /** `.forge/` itself was removed, or replaced by a link or file. */
  readonly controlDirectoryReplaced: boolean;
  readonly stateFileChanged: boolean;
  readonly lockFileChanged: boolean;
  /** Validation problems found in protected documents after the run. */
  readonly problems: readonly string[];
}

const PROJECT_FILE = 'project.json';
const STATE_FILE = 'state.json';
const LOCK_FILE = 'state.lock';
const GITIGNORE_FILE = '.gitignore';
/** The validation profile is executable configuration, so read-only runs verify it too. */
const VALIDATION_FILE = 'validation.json';
/** Project configuration chooses orchestration defaults, so read-only runs verify it too. */
const CONFIG_FILE = 'config.json';
const METADATA_SCOPE_FILES = [PROJECT_FILE, GITIGNORE_FILE, VALIDATION_FILE, CONFIG_FILE];

/** Bounds on what a snapshot walks and keeps. */
const MAX_ENTRIES = 1_000;
const MAX_DEPTH = 4;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 16 * 1024 * 1024;

export async function snapshotControlState(layout: ForgeLayout, scope: ControlSnapshotScope): Promise<ControlSnapshot> {
  const entries = new Map<string, EntryFingerprint>();
  const contents = new Map<string, Buffer>();
  const budget = { bytes: 0 };

  const root = await fingerprint(layout.forgeDir);
  entries.set('.', root.fingerprint);

  if (root.fingerprint.kind === 'directory') {
    if (scope === 'metadata') {
      for (const name of METADATA_SCOPE_FILES) {
        await record(join(layout.forgeDir, name), name, entries, contents, budget);
      }
    } else {
      await walk(layout.forgeDir, layout.forgeDir, 0, entries, contents, budget);
    }
  }
  return { scope, forgeDir: layout.forgeDir, takenAt: new Date().toISOString(), entries, contents };
}

/**
 * Compares the current `.forge/` with `snapshot`, then checks whether the
 * protected documents still validate. Reads only; never writes.
 */
export async function verifyControlState(project: LoadedProject, snapshot: ControlSnapshot): Promise<IntegrityReport> {
  const current = await snapshotControlState(project.layout, snapshot.scope);
  const changes: IntegrityChange[] = [];

  for (const [path, before] of snapshot.entries) {
    const after = current.entries.get(path);
    if (after === undefined || after.kind === 'unreadable') {
      changes.push({ path, change: 'removed', before, after: after ?? null });
    } else if (!sameEntry(before, after)) {
      changes.push({ path, change: 'modified', before, after });
    }
  }
  for (const [path, after] of current.entries) {
    if (!snapshot.entries.has(path)) {
      changes.push({ path, change: 'added', before: null, after });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));

  const touched = (name: string): boolean => changes.some((change) => change.path === name);
  const report = {
    scope: snapshot.scope,
    changes,
    controlDirectoryReplaced: touched('.'),
    stateFileChanged: snapshot.scope === 'full' && touched(STATE_FILE),
    lockFileChanged: snapshot.scope === 'full' && touched(LOCK_FILE),
  };
  const problems = changes.length === 0 ? [] : await validateProtectedDocuments(project);
  return { ok: changes.length === 0, ...report, problems };
}

/**
 * One-line description of the changes, e.g. `modified .forge/state.json, removed .forge/project.json`.
 * Paths are shown with their `.forge/` prefix: a bare `npm-cache` reads like a project-root path.
 */
export function describeIntegrityChanges(report: IntegrityReport): string {
  return report.changes.map((change) => `${change.change} ${change.path === '.' ? '.forge/' : `.forge/${change.path}`}`).join(', ');
}

/**
 * Writes a diagnostic report outside the project (never into `.forge/`):
 * what changed, fingerprints before/after, validation problems, and the
 * original bytes of changed files. Returns the report path.
 */
export async function writeIntegrityEvidence(options: {
  readonly directory: string;
  readonly runId: string;
  readonly project: LoadedProject;
  readonly snapshot: ControlSnapshot;
  readonly report: IntegrityReport;
}): Promise<string> {
  const { snapshot, report } = options;
  const originals: Record<string, { encoding: 'utf8' | 'base64'; content: string }> = {};
  for (const change of report.changes) {
    const bytes = snapshot.contents.get(change.path);
    if (bytes !== undefined) {
      const text = bytes.toString('utf8');
      originals[change.path] = Buffer.from(text, 'utf8').equals(bytes)
        ? { encoding: 'utf8', content: text }
        : { encoding: 'base64', content: bytes.toString('base64') };
    }
  }
  const evidence = {
    kind: 'forge-integrity-violation',
    runId: options.runId,
    projectId: options.project.project.id,
    projectRoot: options.project.layout.root,
    controlDirectory: snapshot.forgeDir,
    /** `changes[].path` and `originals` keys are relative to this directory, not to the project root. */
    pathsRelativeTo: snapshot.forgeDir,
    snapshotTakenAt: snapshot.takenAt,
    detectedAt: new Date().toISOString(),
    scope: report.scope,
    changes: report.changes,
    problems: report.problems,
    originals,
    note: 'Forge did not modify or restore any file. Changed files were left exactly as found.',
  };
  const path = join(options.directory, `forge-integrity-${options.runId}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return path;
}

async function walk(
  forgeDir: string,
  directory: string,
  depth: number,
  entries: Map<string, EntryFingerprint>,
  contents: Map<string, Buffer>,
  budget: { bytes: number },
): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (entries.size >= MAX_ENTRIES) {
      // Too many entries to be Forge's own layout; record the overflow as a change marker.
      entries.set('(too many entries)', { kind: 'other', size: 0, sha256: null });
      return;
    }
    const path = join(directory, name);
    const key = relative(forgeDir, path).split(sep).join('/');
    const kind = await record(path, key, entries, contents, budget);
    if (kind === 'directory' && depth < MAX_DEPTH) {
      await walk(forgeDir, path, depth + 1, entries, contents, budget);
    }
  }
}

async function record(
  path: string,
  key: string,
  entries: Map<string, EntryFingerprint>,
  contents: Map<string, Buffer>,
  budget: { bytes: number },
): Promise<EntryKind | undefined> {
  const result = await fingerprint(path);
  if (result.missing) {
    return undefined;
  }
  entries.set(key, result.fingerprint);
  if (result.bytes !== undefined && result.bytes.length <= MAX_EVIDENCE_FILE_BYTES && budget.bytes + result.bytes.length <= MAX_EVIDENCE_TOTAL_BYTES) {
    contents.set(key, result.bytes);
    budget.bytes += result.bytes.length;
  }
  return result.fingerprint.kind;
}

async function fingerprint(path: string): Promise<{ fingerprint: EntryFingerprint; bytes?: Buffer; missing: boolean }> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { fingerprint: { kind: 'unreadable', size: 0, sha256: null }, missing };
  }
  if (info.isSymbolicLink()) {
    return { fingerprint: { kind: 'link', size: info.size, sha256: null }, missing: false };
  }
  if (info.isDirectory()) {
    return { fingerprint: { kind: 'directory', size: 0, sha256: null }, missing: false };
  }
  if (!info.isFile()) {
    return { fingerprint: { kind: 'other', size: info.size, sha256: null }, missing: false };
  }
  try {
    const bytes = await readFile(path);
    return {
      fingerprint: { kind: 'file', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      bytes,
      missing: false,
    };
  } catch {
    return { fingerprint: { kind: 'unreadable', size: info.size, sha256: null }, missing: false };
  }
}

function sameEntry(a: EntryFingerprint, b: EntryFingerprint): boolean {
  return a.kind === b.kind && a.size === b.size && a.sha256 === b.sha256;
}

/** Reports whether project metadata and state still validate (for diagnosis only). */
async function validateProtectedDocuments(project: LoadedProject): Promise<string[]> {
  const problems: string[] = [];
  try {
    const reloaded = await loadProject(project.layout.root);
    if (reloaded.project.id !== project.project.id) {
      problems.push(`project.json now claims a different project ID (${reloaded.project.id})`);
    }
  } catch (error) {
    problems.push(`project.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await openStateStore(project).load();
  } catch (error) {
    problems.push(`state.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}
