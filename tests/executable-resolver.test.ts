import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ProcessRunner, resolveExecutable } from '../src/execution/index.ts';
import type { ResolvedExecutable } from '../src/execution/index.ts';
import { TempDirs } from './fixtures.ts';
import { installFakeClaude } from './worker-fixtures.ts';

const temp = new TempDirs();
after(() => temp.cleanup());

const runner = new ProcessRunner({ defaultTimeoutMs: 30_000 });

function expectResolved(resolution: Awaited<ReturnType<typeof resolveExecutable>>): ResolvedExecutable {
  assert.ok(resolution.ok, resolution.ok ? '' : resolution.message);
  return resolution.executable;
}

describe('resolveExecutable: Windows launchers', () => {
  it('unwraps an npm cmd-shim into node + script (path with spaces)', async () => {
    const fake = await installFakeClaude(temp);
    const executable = expectResolved(await fake.resolve('claude'));

    assert.equal(executable.kind, 'node-script');
    assert.equal(executable.command, process.execPath);
    assert.deepEqual(executable.prefixArgs, [fake.scriptPath]);
    assert.ok(executable.source.endsWith('claude.cmd'));
    assert.ok(fake.binDir.includes(' '), 'fixture path should contain spaces');
  });

  it('passes arguments verbatim to the unwrapped program — no cmd.exe parsing', async () => {
    const dir = join(await temp.make('forge-resolver-'), 'tools dir');
    await mkdir(join(dir, 'node_modules', 'echo'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'echo', 'cli.js'),
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));',
    );
    await writeFile(join(dir, 'echo-args.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\echo\\cli.js" %*\r\n');

    const executable = expectResolved(
      await resolveExecutable('echo-args', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' }),
    );
    // Characters that cmd.exe would interpret: & | < > ^ % " and newlines.
    const tricky = ['a b', '"quoted"', '& calc.exe', '| whoami', '%PATH%', '^^', '<in >out', 'line1\nline2', ''];
    const result = await runner.run({
      command: executable.command,
      args: [...executable.prefixArgs, ...tricky],
      cwd: dir,
    });

    assert.equal(result.outcome, 'success', result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), tricky);
  });

  it('unwraps the older "%~dp0" shim format and prefers a bundled node.exe', async () => {
    const dir = await temp.make('forge-resolver-');
    await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'pkg', 'index.js'), '');
    await writeFile(join(dir, 'node.exe'), '');
    await writeFile(
      join(dir, 'old.cmd'),
      '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\pkg\\index.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\pkg\\index.js" %*\r\n)\r\n',
    );

    const executable = expectResolved(await resolveExecutable('old', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' }));
    assert.equal(executable.command, join(dir, 'node.exe'));
    assert.deepEqual(executable.prefixArgs, [join(dir, 'node_modules', 'pkg', 'index.js')]);
  });

  it('unwraps a shim that wraps a native executable', async () => {
    const dir = await temp.make('forge-resolver-');
    await mkdir(join(dir, 'node_modules', 'tool', 'bin'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'tool', 'bin', 'tool.exe'), '');
    await writeFile(join(dir, 'tool.cmd'), '@ECHO off\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n');

    const executable = expectResolved(await resolveExecutable('tool', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' }));
    assert.equal(executable.kind, 'native');
    assert.equal(executable.command, join(dir, 'node_modules', 'tool', 'bin', 'tool.exe'));
  });

  it('refuses a batch file that is not an npm launcher instead of using a shell', async () => {
    const dir = await temp.make('forge-resolver-');
    await writeFile(join(dir, 'custom.bat'), '@echo off\r\necho %*\r\n');

    const resolution = await resolveExecutable('custom', { env: { PATH: dir, PATHEXT: '.BAT' }, platform: 'win32' });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.ok ? '' : resolution.reason, 'unsupported');
    assert.match(resolution.ok ? '' : resolution.message, /without a shell/);
  });

  it('refuses a launcher whose target is missing', async () => {
    const dir = await temp.make('forge-resolver-');
    await writeFile(join(dir, 'broken.cmd'), '"%_prog%"  "%dp0%\\node_modules\\gone\\cli.js" %*\r\n');
    const resolution = await resolveExecutable('broken', { env: { PATH: dir, PATHEXT: '.CMD' }, platform: 'win32' });
    assert.equal(resolution.ok, false);
    assert.match(resolution.ok ? '' : resolution.message, /does not exist/);
  });
});

describe('resolveExecutable: lookup rules', () => {
  it('reports a missing executable', async () => {
    const dir = await temp.make('forge-resolver-');
    const resolution = await resolveExecutable('forge-no-such-tool-7f3a', { env: { PATH: dir } });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.ok ? '' : resolution.reason, 'not-found');
  });

  it('never searches relative PATH entries or the current directory', async () => {
    const dir = await temp.make('forge-resolver-');
    await writeFile(join(dir, 'planted.cmd'), '"%_prog%" "%dp0%\\x.js" %*');
    const resolution = await resolveExecutable('planted', { env: { PATH: '.;relative\\bin', PATHEXT: '.CMD' }, platform: 'win32' });
    assert.equal(resolution.ok, false);
  });

  it('follows PATH order and PATHEXT order', async () => {
    const first = await temp.make('forge-resolver-');
    const second = await temp.make('forge-resolver-');
    await writeFile(join(first, 'tool.exe'), '');
    await writeFile(join(second, 'tool.exe'), '');
    await writeFile(join(first, 'tool.com'), '');

    const executable = expectResolved(
      await resolveExecutable('tool', { env: { PATH: [first, second].join(process.platform === 'win32' ? ';' : ':'), PATHEXT: '.COM;.EXE' }, platform: 'win32' }),
    );
    assert.equal(executable.command, join(first, 'tool.com'));
  });

  it('accepts an explicit absolute path, including one with spaces', async () => {
    const fake = await installFakeClaude(temp);
    const executable = expectResolved(await resolveExecutable(fake.scriptPath));
    assert.equal(executable.kind, 'node-script');
    assert.deepEqual(executable.prefixArgs, [fake.scriptPath]);
  });

  for (const name of ['', '   ', 'a\0b', 'bin/claude', '..\\claude', 'claude;calc', 'cla ude', '$(whoami)']) {
    it(`rejects unsafe or relative name ${JSON.stringify(name)}`, async () => {
      const resolution = await resolveExecutable(name, { env: { PATH: await temp.make('forge-resolver-') } });
      assert.equal(resolution.ok, false);
      assert.equal(resolution.ok ? '' : resolution.reason, 'invalid');
    });
  }

  it('requires the execute permission on POSIX', { skip: process.platform === 'win32' ? 'POSIX permissions' : false }, async () => {
    const dir = await temp.make('forge-resolver-');
    await writeFile(join(dir, 'tool'), '#!/bin/sh\n');
    await chmod(join(dir, 'tool'), 0o644);
    assert.equal((await resolveExecutable('tool', { env: { PATH: dir } })).ok, false);
    await chmod(join(dir, 'tool'), 0o755);
    assert.equal((await resolveExecutable('tool', { env: { PATH: dir } })).ok, true);
  });

  it('resolves the Node executable on the real PATH', async () => {
    const resolution = await resolveExecutable('node');
    assert.equal(resolution.ok, true);
  });
});
