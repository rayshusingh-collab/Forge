import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProjectError, ValidationError } from '../src/core/errors.ts';
import {
  FORGE_GITIGNORE_CONTENT,
  discoverProject,
  loadProject,
  openStateStore,
  pathsEqual,
  registerProject,
} from '../src/projects/index.ts';
import type { RegisterProjectOptions } from '../src/projects/index.ts';
import { TempDirs, gitStatusPorcelain, initGitRepo, testRunner, tryLinkDirectory } from './fixtures.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOW = new Date('2026-03-04T05:06:07.089Z');

const temp = new TempDirs();
after(() => temp.cleanup());

async function newRepo(name = 'app'): Promise<string> {
  return initGitRepo(join(await temp.make('forge-project-'), name));
}

function register(path: string, overrides: Partial<RegisterProjectOptions> = {}) {
  return registerProject({ path, cwd: path, runner: testRunner, clock: () => NOW, ...overrides });
}

async function expectProjectError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ProjectError, `expected ProjectError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe('registerProject', () => {
  it('registers a Git repository and creates initial metadata', async () => {
    const root = await newRepo('my-app');
    await writeFile(join(root, 'README.md'), 'existing content');

    const registered = await register(root, { description: 'Demo project' });

    assert.match(registered.project.id, UUID);
    assert.equal(registered.project.name, 'my-app');
    assert.equal(registered.project.description, 'Demo project');
    assert.equal(registered.project.status, 'active');
    assert.equal(registered.project.schemaVersion, 1);
    assert.ok(pathsEqual(registered.project.rootPath, root));
    assert.equal(registered.project.createdAt, NOW.toISOString());

    assert.deepEqual((await readdir(join(root, '.forge'))).sort(), ['.gitignore', 'project.json', 'state.json']);
    assert.equal(await readFile(join(root, '.forge', '.gitignore'), 'utf8'), FORGE_GITIGNORE_CONTENT);

    const state = await openStateStore(registered).load();
    assert.equal(state.projectId, registered.project.id);
    assert.equal(state.phase, 'idle');
    assert.equal(state.revision, 1);
    assert.deepEqual([state.milestones, state.tasks, state.decisions], [[], [], []]);
  });

  it('preserves existing files and leaves the Git working tree untouched', async () => {
    const root = await newRepo();
    await writeFile(join(root, 'index.js'), 'console.log(1);\n');
    const statusBefore = await gitStatusPorcelain(root);

    await register(root);

    assert.equal(await readFile(join(root, 'index.js'), 'utf8'), 'console.log(1);\n');
    // `.forge/.gitignore` hides all metadata, so Git sees no change at all.
    assert.equal(await gitStatusPorcelain(root), statusBefore);
  });

  it('stores the canonical root when given a relative, non-normalized path', async () => {
    const root = await newRepo('rel-app');
    const parent = join(root, '..');
    const registered = await register('./rel-app/../rel-app/', { cwd: parent });
    assert.ok(pathsEqual(registered.project.rootPath, root));
    assert.equal(registered.project.rootPath, (await loadProject(root)).project.rootPath);
  });

  it('accepts an explicit name and treats a blank description as none', async () => {
    const registered = await register(await newRepo(), { name: '  Shop Frontend  ', description: '   ' });
    assert.equal(registered.project.name, 'Shop Frontend');
    assert.equal(registered.project.description, null);
  });

  it('rejects invalid names', async () => {
    const root = await newRepo();
    await assert.rejects(register(root, { name: '   ' }), ValidationError);
    await assert.rejects(register(root, { name: 'bad\nname' }), ValidationError);
    await assert.rejects(register(root, { name: 'x'.repeat(101) }), ValidationError);
  });

  it('rejects a path that does not exist', async () => {
    const base = await temp.make();
    await expectProjectError(register(join(base, 'missing')), /does not exist/);
  });

  it('rejects a file', async () => {
    const base = await temp.make();
    const file = join(base, 'file.txt');
    await writeFile(file, '');
    await expectProjectError(register(file, { cwd: base }), /not a directory/);
  });

  it('rejects a directory that is not a Git repository', async () => {
    const dir = await temp.make('forge-nogit-');
    await expectProjectError(register(dir), /Git work tree/);
    await assert.rejects(readdir(join(dir, '.forge')), { code: 'ENOENT' });
  });

  it('rejects a subdirectory of a repository', async () => {
    const root = await newRepo();
    const sub = join(root, 'packages', 'web');
    await mkdir(sub, { recursive: true });
    await expectProjectError(register(sub), /not its root/);
  });

  it('rejects duplicate registration', async () => {
    const root = await newRepo();
    const first = await register(root);
    await expectProjectError(register(root), new RegExp(`already registered.*${first.project.id}`));
  });

  it('refuses to touch an existing foreign .forge directory', async () => {
    const root = await newRepo();
    await mkdir(join(root, '.forge'));
    await writeFile(join(root, '.forge', 'other-tool.cfg'), 'keep me');

    await expectProjectError(register(root), /not valid Forge metadata/);
    assert.deepEqual(await readdir(join(root, '.forge')), ['other-tool.cfg']);
  });

  it('reports a missing Git executable clearly', async () => {
    const root = await newRepo();
    await expectProjectError(register(root, { gitExecutable: 'forge-missing-git-7f3a' }), /Git could not be started/);
  });

  it('gives each project a distinct, stable ID', async () => {
    const a = await register(await newRepo('a'));
    const b = await register(await newRepo('b'));
    assert.notEqual(a.project.id, b.project.id);
    assert.equal((await loadProject(a.project.rootPath)).project.id, a.project.id);
  });
});

describe('discoverProject', () => {
  it('finds the project from its root', async () => {
    const root = await newRepo();
    const registered = await register(root);
    const found = await discoverProject(root);
    assert.equal(found?.project.id, registered.project.id);
  });

  it('finds the project from a nested directory', async () => {
    const root = await newRepo();
    const registered = await register(root);
    const nested = join(root, 'src', 'components', 'deep');
    await mkdir(nested, { recursive: true });

    const found = await discoverProject(nested);
    assert.equal(found?.project.id, registered.project.id);
    assert.ok(pathsEqual(found?.layout.root ?? '', root));
  });

  it('returns undefined after reaching the filesystem root', async () => {
    const dir = await temp.make('forge-noproject-');
    assert.equal(await discoverProject(dir), undefined);
  });

  it('rejects a start directory that does not exist', async () => {
    const dir = await temp.make();
    await expectProjectError(discoverProject(join(dir, 'missing')), /does not exist/);
  });

  it('prefers the nearest project', async () => {
    const outer = await newRepo('outer');
    await register(outer);
    const inner = await initGitRepo(join(outer, 'vendor', 'inner'));
    const innerProject = await register(inner);

    assert.equal((await discoverProject(join(inner)))?.project.id, innerProject.project.id);
  });

  it('skips a .forge directory that has no project metadata', async () => {
    const root = await newRepo();
    const registered = await register(root);
    const nested = join(root, 'tools');
    await mkdir(join(nested, '.forge'), { recursive: true });

    assert.equal((await discoverProject(nested))?.project.id, registered.project.id);
  });

  it('fails on malformed metadata instead of skipping or trusting it', async () => {
    const root = await newRepo();
    await register(root);
    const nested = join(root, 'packages', 'lib');
    await mkdir(join(nested, '.forge'), { recursive: true });
    await writeFile(join(nested, '.forge', 'project.json'), '{ not json');

    await expectProjectError(discoverProject(nested), /Project metadata is unreadable.*not valid JSON/);
  });

  it('fails on structurally invalid metadata', async () => {
    const root = await newRepo();
    await register(root);
    const file = join(root, '.forge', 'project.json');
    const doc = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...doc, status: 'deleted' }));

    await expectProjectError(discoverProject(root), /status must be one of/);
  });

  it('fails on an unsupported metadata version', async () => {
    const root = await newRepo();
    await register(root);
    const file = join(root, '.forge', 'project.json');
    const doc = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...doc, schemaVersion: 99 }));

    await expectProjectError(discoverProject(root), /newer than this Forge supports/);
  });

  it('refuses metadata copied from another project', async () => {
    const original = await newRepo('original');
    await register(original);
    const copy = await newRepo('copy');
    await cp(join(original, '.forge'), join(copy, '.forge'), { recursive: true });

    await expectProjectError(discoverProject(copy), /moved or copied/);
  });

  it('refuses a .forge directory that is a link', async (t) => {
    const elsewhere = await newRepo('elsewhere');
    await register(elsewhere);
    const root = await newRepo('linked');
    if (!(await tryLinkDirectory(join(elsewhere, '.forge'), join(root, '.forge')))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    await expectProjectError(discoverProject(root), /symbolic link or junction/);
  });

  it('keeps the default name derived from the directory', async () => {
    const root = await newRepo('named-by-dir');
    await register(root);
    assert.equal((await discoverProject(root))?.project.name, basename(root));
  });
});
