import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AuthorizationError, ValidationError } from '../src/core/errors.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import { WORKER_REQUEST_LIMITS, prepareWorkerRequest } from '../src/workers/index.ts';
import type { PrepareWorkerRequestInput } from '../src/workers/index.ts';
import { TempDirs, tryLinkDirectory } from './fixtures.ts';
import { createTestProject } from './worker-fixtures.ts';

const temp = new TempDirs();
let project: LoadedProject;
let outside: string;

before(async () => {
  project = await createTestProject(temp);
  await mkdir(join(project.layout.root, 'src', 'nested'), { recursive: true });
  await writeFile(join(project.layout.root, 'src', 'file.ts'), '');
  outside = await temp.make('forge-outside-');
});
after(() => temp.cleanup());

function prepare(overrides: Partial<PrepareWorkerRequestInput> = {}) {
  return prepareWorkerRequest({ project, task: 'Do something', access: 'read-only', timeoutMs: 60_000, ...overrides });
}

describe('prepareWorkerRequest: working directory boundary', () => {
  it('defaults to the project root', async () => {
    const request = await prepare();
    assert.equal(request.workingDirectory, project.layout.root);
    assert.equal(request.relativeWorkingDirectory, '.');
    assert.equal(request.projectId, project.project.id);
    assert.match(request.id, /^[0-9a-f-]{36}$/);
  });

  it('accepts an authorized nested directory (relative or absolute)', async () => {
    assert.equal((await prepare({ workingDirectory: 'src/nested' })).relativeWorkingDirectory, 'src/nested');
    const absolute = await prepare({ workingDirectory: join(project.layout.root, 'src') });
    assert.equal(absolute.relativeWorkingDirectory, 'src');
  });

  it('rejects a directory outside the project', async () => {
    await assert.rejects(prepare({ workingDirectory: outside }), AuthorizationError);
  });

  it('rejects traversal out of the project', async () => {
    await assert.rejects(prepare({ workingDirectory: 'src/../../' }), AuthorizationError);
    await assert.rejects(prepare({ workingDirectory: '..' }), AuthorizationError);
  });

  it('rejects the sibling directory sharing the root prefix', async () => {
    const sibling = `${project.layout.root}-evil`;
    await mkdir(sibling);
    await assert.rejects(prepare({ workingDirectory: sibling }), AuthorizationError);
  });

  it('rejects a link or junction that escapes the project', async (t) => {
    const link = join(project.layout.root, 'escape');
    if (!(await tryLinkDirectory(outside, link))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    await assert.rejects(prepare({ workingDirectory: 'escape' }), /symbolic link or junction/);
  });

  it('rejects Forge metadata and Git internals, even through a link', async (t) => {
    await assert.rejects(prepare({ workingDirectory: '.forge' }), /may not run inside \.forge/);
    await assert.rejects(prepare({ workingDirectory: '.git' }), /may not run inside \.git/);
    const link = join(project.layout.root, 'git-link');
    if (!(await tryLinkDirectory(join(project.layout.root, '.git'), link))) {
      t.skip('OS does not permit creating directory links');
      return;
    }
    await assert.rejects(prepare({ workingDirectory: 'git-link' }), /may not run inside \.git/);
  });

  it('rejects a file or missing directory', async () => {
    await assert.rejects(prepare({ workingDirectory: 'src/file.ts' }), ValidationError);
    await assert.rejects(prepare({ workingDirectory: 'src/missing' }), ValidationError);
  });
});

describe('prepareWorkerRequest: content validation', () => {
  it('trims task and context', async () => {
    const request = await prepare({ task: '  Explain  ', context: '  notes  ' });
    assert.equal(request.task, 'Explain');
    assert.equal(request.context, 'notes');
  });

  it('treats blank context as none', async () => {
    assert.equal((await prepare({ context: '   ' })).context, null);
  });

  it('rejects an empty task', async () => {
    await assert.rejects(prepare({ task: '' }), /Task must not be empty/);
    await assert.rejects(prepare({ task: ' \n\t ' }), /Task must not be empty/);
  });

  it('rejects an oversized task', async () => {
    await assert.rejects(prepare({ task: 'x'.repeat(WORKER_REQUEST_LIMITS.taskCharacters + 1) }), /Task is too long/);
    await prepare({ task: 'x'.repeat(WORKER_REQUEST_LIMITS.taskCharacters) });
  });

  it('rejects oversized context', async () => {
    await assert.rejects(prepare({ context: 'x'.repeat(WORKER_REQUEST_LIMITS.contextCharacters + 1) }), /Context is too long/);
  });

  it('rejects NUL characters', async () => {
    await assert.rejects(prepare({ task: 'a\0b' }), ValidationError);
  });

  for (const timeoutMs of [0, -5, 1.5, Number.NaN, WORKER_REQUEST_LIMITS.maxTimeoutMs + 1]) {
    it(`rejects timeout ${timeoutMs}`, async () => {
      await assert.rejects(prepare({ timeoutMs }), /timeout must be an integer/);
    });
  }

  it('keeps shell syntax as plain text', async () => {
    const request = await prepare({ task: '$(rm -rf /) && del /s *.* | echo %PATH%' });
    assert.equal(request.task, '$(rm -rf /) && del /s *.* | echo %PATH%');
  });
});
