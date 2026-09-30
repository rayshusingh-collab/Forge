import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AuthorizationError } from '../src/core/errors.ts';
import {
  POSIX_PATH_RULES,
  ProjectPathBoundary,
  WINDOWS_PATH_RULES,
  isWithin,
  pathsEqual,
} from '../src/projects/index.ts';
import { TempDirs, tryLinkDirectory } from './fixtures.ts';

// Windows semantics are tested through path.win32, so these run identically on any OS.
describe('ProjectPathBoundary (Windows rules, lexical)', () => {
  const boundary = new ProjectPathBoundary('C:\\project', WINDOWS_PATH_RULES);

  const inside: readonly (readonly [string, string])[] = [
    ['.', 'C:\\project'],
    ['C:\\project', 'C:\\project'],
    ['C:\\project\\', 'C:\\project'],
    ['src\\index.ts', 'C:\\project\\src\\index.ts'],
    ['src/deep/nested/file.ts', 'C:\\project\\src\\deep\\nested\\file.ts'],
    ['src/./a//b.ts', 'C:\\project\\src\\a\\b.ts'],
    ['src\\..\\lib\\x.ts', 'C:\\project\\lib\\x.ts'],
    ['a\\b\\..\\..\\c', 'C:\\project\\c'],
    ['C:\\project\\src\\..\\README.md', 'C:\\project\\README.md'],
    ['c:\\PROJECT\\Src', 'C:\\project\\Src'],
    ['..foo', 'C:\\project\\..foo'],
    ['/project/x', 'C:\\project\\x'],
  ];
  for (const [requested, expected] of inside) {
    it(`authorizes ${JSON.stringify(requested)}`, () => {
      assert.ok(pathsEqual(boundary.resolve(requested), expected, WINDOWS_PATH_RULES));
      assert.equal(boundary.contains(requested), true);
    });
  }

  it('treats paths case-insensitively', () => {
    assert.equal(boundary.resolve('C:\\PROJECT\\file.txt').toLowerCase(), 'c:\\project\\file.txt');
  });

  const outside = [
    '..',
    '..\\',
    '..\\other',
    'src\\..\\..\\other',
    'a/../../project-evil',
    'C:\\project-evil',
    'C:\\project-evil\\x',
    'C:\\projectx',
    'C:\\',
    'C:\\other\\project',
    'D:\\project',
    'D:relative',
    '\\\\server\\share\\project',
  ];
  for (const requested of outside) {
    it(`rejects ${JSON.stringify(requested)}`, () => {
      assert.throws(() => boundary.resolve(requested), AuthorizationError);
      assert.equal(boundary.contains(requested), false);
    });
  }

  const unsafe = [
    '',
    'a\0b',
    '\\\\?\\C:\\project\\x',
    '\\\\.\\C:\\project\\x',
    '//?/C:/project/x',
    'file.txt:hidden',
    'NUL',
    'src\\nul.txt',
    'con ',
    'COM1',
    'lpt9.log',
  ];
  for (const requested of unsafe) {
    it(`rejects unsafe syntax ${JSON.stringify(requested)}`, () => {
      assert.throws(() => boundary.resolve(requested), AuthorizationError);
    });
  }

  it('allows names that merely resemble device names', () => {
    assert.equal(boundary.contains('console.log'), true);
    assert.equal(boundary.contains('nullable.ts'), true);
    assert.equal(boundary.contains('com10'), true);
  });

  it('requires an absolute root', () => {
    assert.throws(() => new ProjectPathBoundary('project', WINDOWS_PATH_RULES), AuthorizationError);
  });

  it('refuses filesystem authorization with foreign path rules', async () => {
    const foreign = process.platform === 'win32' ? POSIX_PATH_RULES : WINDOWS_PATH_RULES;
    const root = foreign.windows ? 'C:\\project' : '/project';
    await assert.rejects(new ProjectPathBoundary(root, foreign).authorize('x'), AuthorizationError);
  });
});

describe('ProjectPathBoundary (POSIX rules, lexical)', () => {
  const boundary = new ProjectPathBoundary('/home/dev/project', POSIX_PATH_RULES);

  it('authorizes the root and children', () => {
    assert.equal(boundary.resolve('.'), '/home/dev/project');
    assert.equal(boundary.resolve('src/index.ts'), '/home/dev/project/src/index.ts');
    assert.equal(boundary.resolve('/home/dev/project/a/../b'), '/home/dev/project/b');
  });

  it('rejects escapes and misleading prefixes', () => {
    for (const requested of ['..', '../project-evil', '/home/dev/project-evil', '/etc/passwd', 'a/../../x']) {
      assert.equal(boundary.contains(requested), false, requested);
    }
  });

  it('is case-sensitive', () => {
    assert.equal(boundary.contains('/home/dev/PROJECT/x'), false);
  });

  it('does not apply Windows-only rules', () => {
    assert.equal(boundary.contains('NUL'), true);
    assert.equal(boundary.contains('a:b'), true);
  });
});

describe('isWithin / pathsEqual', () => {
  it('never uses string-prefix matching', () => {
    assert.equal(isWithin('C:\\project', 'C:\\project-evil', WINDOWS_PATH_RULES), false);
    assert.equal(isWithin('/srv/app', '/srv/app2/file', POSIX_PATH_RULES), false);
  });

  it('compares Windows paths case-insensitively and POSIX paths exactly', () => {
    assert.equal(pathsEqual('C:\\Project', 'c:\\project\\', WINDOWS_PATH_RULES), true);
    assert.equal(pathsEqual('/srv/App', '/srv/app', POSIX_PATH_RULES), false);
  });
});

describe('ProjectPathBoundary.authorize (real filesystem)', () => {
  const temp = new TempDirs();
  let root: string;
  let outsideDir: string;
  let boundary: ProjectPathBoundary;

  before(async () => {
    const base = await temp.make('forge-boundary-');
    root = join(base, 'project');
    outsideDir = join(base, 'project-evil');
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(outsideDir);
    await writeFile(join(root, 'src', 'index.ts'), '');
    await writeFile(join(outsideDir, 'secret.txt'), 'outside');
    boundary = new ProjectPathBoundary(root);
  });

  after(() => temp.cleanup());

  it('authorizes the root itself', async () => {
    const result = await boundary.authorize('.');
    assert.equal(result.relativePath, '');
    assert.equal(result.exists, true);
  });

  it('authorizes an existing file', async () => {
    const result = await boundary.authorize('src/index.ts');
    assert.equal(result.exists, true);
    assert.ok(pathsEqual(result.resolvedPath, join(root, 'src', 'index.ts')));
  });

  it('authorizes a path that does not exist yet', async () => {
    const result = await boundary.authorize('src/new/file.ts');
    assert.equal(result.exists, false);
    assert.ok(pathsEqual(result.resolvedPath, join(root, 'src', 'new', 'file.ts')));
  });

  it('rejects the sibling directory sharing the root prefix', async () => {
    await assert.rejects(boundary.authorize(join(outsideDir, 'secret.txt')), AuthorizationError);
    await assert.rejects(boundary.authorize('../project-evil/secret.txt'), AuthorizationError);
  });

  it('rejects a link inside the project that points outside it', async (t) => {
    const link = join(root, 'escape');
    if (!(await tryLinkDirectory(outsideDir, link))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    // Lexically the path looks fine; only link resolution reveals the escape.
    assert.equal(boundary.contains('escape/secret.txt'), true);
    await assert.rejects(boundary.authorize('escape'), /symbolic link or junction/);
    await assert.rejects(boundary.authorize('escape/secret.txt'), /symbolic link or junction/);
    await assert.rejects(boundary.authorize('escape/not-yet-created.txt'), /symbolic link or junction/);
  });

  it('allows a link that stays inside the project', async (t) => {
    const link = join(root, 'src-link');
    if (!(await tryLinkDirectory(join(root, 'src'), link))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    const result = await boundary.authorize('src-link/index.ts');
    assert.ok(pathsEqual(result.resolvedPath, join(root, 'src', 'index.ts')));
  });

  it('rejects a broken link', async (t) => {
    const missingTarget = join(outsideDir, 'gone');
    await mkdir(missingTarget);
    const link = join(root, 'dangling');
    if (!(await tryLinkDirectory(missingTarget, link))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    await rm(missingTarget, { recursive: true });
    await assert.rejects(boundary.authorize('dangling/x'), AuthorizationError);
  });
});
