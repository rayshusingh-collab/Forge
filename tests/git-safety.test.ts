import assert from 'node:assert/strict';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { GitClient, captureChanges, parsePorcelainV2, takeSnapshot, toBaseline } from '../src/git/index.ts';
import type { ChangeSummary } from '../src/state/index.ts';
import { TempDirs, testRunner } from './fixtures.ts';
import { createRepo, git, write } from './git-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());
const NOW = new Date('2026-06-01T00:00:00.000Z');

async function client(root: string): Promise<GitClient> {
  return GitClient.create({ runner: testRunner, root });
}

/** Captures a baseline, runs `task`, and returns the attributed changes. */
async function delta(root: string, task: () => Promise<void>, scope = '.'): Promise<ChangeSummary> {
  const gitClient = await client(root);
  const baseline = toBaseline(await takeSnapshot(gitClient), NOW);
  await task();
  return captureChanges(gitClient, baseline, scope, NOW);
}

function byPath(changes: ChangeSummary): Record<string, string> {
  return Object.fromEntries(changes.files.map((file) => [file.path, `${file.change}:${file.attribution}`]));
}

describe('porcelain v2 parsing', () => {
  it('parses branch headers, ordinary, renamed, unmerged, and untracked entries', () => {
    const output = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa src/a file.ts',
      '2 R. N... 100644 100644 100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee conflict.ts',
      '? notes.txt',
      '',
    ].join('\0');
    const status = parsePorcelainV2(output);
    assert.equal(status.head, '1111111111111111111111111111111111111111');
    assert.equal(status.branch, 'main');
    assert.deepEqual(
      status.entries.map((entry) => [entry.kind, entry.path, entry.origPath, entry.index, entry.worktree]),
      [
        ['tracked', 'src/a file.ts', null, '.', 'M'],
        ['renamed', 'new.ts', 'old.ts', 'R', '.'],
        ['unmerged', 'conflict.ts', null, 'U', 'U'],
        ['untracked', 'notes.txt', null, '?', '?'],
      ],
    );
  });

  it('parses unborn and detached HEADs', () => {
    assert.equal(parsePorcelainV2('# branch.oid (initial)\0# branch.head main\0').head, null);
    assert.equal(parsePorcelainV2('# branch.oid 1111111111111111111111111111111111111111\0# branch.head (detached)\0').branch, null);
  });

  it('rejects malformed output', () => {
    assert.throws(() => parsePorcelainV2('garbage\0'), /Malformed/);
    assert.throws(() => parsePorcelainV2('? x\0'), /missing branch header/);
  });
});

describe('Git baseline', () => {
  it('captures a clean repository', async () => {
    const root = await createRepo(temp);
    const snapshot = await takeSnapshot(await client(root));
    assert.match(snapshot.head ?? '', /^[0-9a-f]{40}$/);
    assert.ok(snapshot.branch === 'master' || snapshot.branch === 'main');
    assert.equal(snapshot.entries.size, 0);
  });

  it('captures modified, staged, untracked, deleted, and renamed paths with fingerprints', async () => {
    const root = await createRepo(temp, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' });
    await write(root, 'a.txt', 'modified\n');
    await write(root, 'b.txt', 'staged\n');
    await git(root, 'add', 'b.txt');
    await write(root, 'new.txt', 'untracked\n');
    await rm(join(root, 'c.txt'));
    await git(root, 'mv', 'd.txt', 'd2.txt');

    const baseline = toBaseline(await takeSnapshot(await client(root)), NOW);
    const entries = Object.fromEntries(baseline.entries.map((entry) => [entry.path, `${entry.index}${entry.worktree}`]));
    assert.deepEqual(entries, { 'a.txt': '.M', 'b.txt': 'M.', 'c.txt': '.D', 'd2.txt': 'R.', 'new.txt': '??' });
    assert.match(baseline.entries.find((entry) => entry.path === 'a.txt')!.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(baseline.entries.find((entry) => entry.path === 'c.txt')!.fingerprint, 'missing');
    assert.equal(baseline.truncated, false);
  });

  it('captures a detached HEAD', async () => {
    const root = await createRepo(temp);
    await git(root, 'checkout', '-q', '--detach');
    const snapshot = await takeSnapshot(await client(root));
    assert.equal(snapshot.branch, null);
    assert.notEqual(snapshot.head, null);
  });

  it('captures a repository with no commits yet', async () => {
    const root = await createRepo(temp, { 'README.md': 'x' }, { commit: false });
    const snapshot = await takeSnapshot(await client(root));
    assert.equal(snapshot.head, null);
    assert.equal(snapshot.entries.get('README.md')?.kind, 'untracked');
  });
});

describe('change attribution', () => {
  it('attributes a new file to the task', async () => {
    const root = await createRepo(temp);
    const changes = await delta(root, () => write(root, 'src/new.js', 'x'));
    assert.deepEqual(byPath(changes), { 'src/new.js': 'added:task' });
  });

  it('attributes a modification of a clean tracked file to the task', async () => {
    const root = await createRepo(temp, { 'a.js': '1' });
    assert.deepEqual(byPath(await delta(root, () => write(root, 'a.js', '2'))), { 'a.js': 'modified:task' });
  });

  it('attributes a deletion of a clean tracked file to the task', async () => {
    const root = await createRepo(temp, { 'a.js': '1' });
    assert.deepEqual(byPath(await delta(root, () => rm(join(root, 'a.js')))), { 'a.js': 'deleted:task' });
  });

  it('reports a worktree rename as a deletion plus an addition', async () => {
    const root = await createRepo(temp, { 'a.js': '1' });
    const changes = await delta(root, () => rename(join(root, 'a.js'), join(root, 'b.js')));
    assert.deepEqual(byPath(changes), { 'a.js': 'deleted:task', 'b.js': 'added:task' });
  });

  it('leaves a pre-existing dirty file untouched by the task out of the task changes', async () => {
    const root = await createRepo(temp, { 'user.js': '1', 'a.js': '1' });
    await write(root, 'user.js', 'user work in progress');
    const changes = await delta(root, () => write(root, 'a.js', 'task'));
    assert.deepEqual(byPath(changes), { 'a.js': 'modified:task' });
    assert.equal(changes.preexistingUntouched, 1);
  });

  it('marks a pre-existing dirty file modified again as mixed', async () => {
    const root = await createRepo(temp, { 'shared.js': '1' });
    await write(root, 'shared.js', 'user edit');
    const changes = await delta(root, () => write(root, 'shared.js', 'user edit + task edit'));
    assert.deepEqual(byPath(changes), { 'shared.js': 'modified:mixed' });
  });

  it('distinguishes pre-existing untracked files the task left alone from ones it changed', async () => {
    const root = await createRepo(temp);
    await write(root, 'notes.txt', 'mine');
    await write(root, 'draft.txt', 'mine');
    const changes = await delta(root, () => write(root, 'draft.txt', 'mine, then the task'));
    assert.deepEqual(byPath(changes), { 'draft.txt': 'added:mixed' });
    assert.equal(changes.preexistingUntouched, 1);
  });

  it('treats a pre-existing change the task reverted as mixed', async () => {
    const root = await createRepo(temp, { 'a.js': 'original' });
    await write(root, 'a.js', 'user edit');
    const changes = await delta(root, () => write(root, 'a.js', 'original'));
    assert.deepEqual(byPath(changes), { 'a.js': 'modified:mixed' });
  });

  it('keeps pre-existing staged changes out of the task and detects staging during the task', async () => {
    const root = await createRepo(temp, { 'staged.js': '1', 'a.js': '1' });
    await write(root, 'staged.js', 'staged by user');
    await git(root, 'add', 'staged.js');
    const changes = await delta(root, async () => {
      await write(root, 'a.js', 'task');
      await git(root, 'add', 'a.js');
    });
    assert.deepEqual(byPath(changes), { 'a.js': 'modified:task' });
    assert.deepEqual(changes.indexChanged, ['a.js']);
    assert.equal(changes.preexistingUntouched, 1);
  });

  it('flags changes outside the task working directory', async () => {
    const root = await createRepo(temp, { 'pkg/a.js': '1', 'other/b.js': '1' });
    const changes = await delta(
      root,
      async () => {
        await write(root, 'pkg/a.js', '2');
        await write(root, 'other/b.js', '2');
      },
      'pkg',
    );
    assert.deepEqual(changes.outOfScope, ['other/b.js']);
  });

  it('records HEAD movement', async () => {
    const root = await createRepo(temp, { 'a.js': '1' });
    const changes = await delta(root, async () => {
      await write(root, 'a.js', '2');
      await git(root, 'commit', '-q', '-am', 'sneaky');
    });
    assert.notEqual(changes.head, changes.baseline.head);
  });

  it('never reports ignored files or .forge metadata', async () => {
    const root = await createRepo(temp, { '.gitignore': 'dist/\n' });
    const changes = await delta(root, async () => {
      await write(root, 'dist/out.js', 'built');
      await write(root, '.forge/.gitignore', '*\n');
      await write(root, '.forge/state.json', '{}');
    });
    assert.deepEqual(changes.files, []);
  });
});

describe('GitClient safety surface', () => {
  it('exposes no destructive or remote operations', () => {
    const methods = Object.getOwnPropertyNames(GitClient.prototype);
    for (const forbidden of ['push', 'reset', 'clean', 'checkout', 'stash', 'rebase', 'merge', 'amend', 'deleteBranch', 'fetch', 'pull']) {
      assert.ok(!methods.some((method) => method.toLowerCase().includes(forbidden.toLowerCase())), `GitClient must not offer ${forbidden}`);
    }
  });

  it('treats pathspec characters literally', async () => {
    const root = await createRepo(temp);
    // As a glob, "[literal].txt" would also match "l.txt"; it must match only itself.
    await write(root, '[literal].txt', 'x');
    await write(root, 'l.txt', 'y');
    const gitClient = await client(root);
    await gitClient.addPaths(['[literal].txt']);
    const staged = (await git(root, 'diff', '--cached', '--name-only')).trim().split('\n');
    assert.deepEqual(staged, ['[literal].txt']);
  });
});
