import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveExecutable } from '../src/execution/index.ts';
import type { ExecutableResolution } from '../src/execution/index.ts';
import type { TempDirs } from './fixtures.ts';

const FAKE_CODEX_SOURCE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

export interface FakeCodexConfig {
  readonly mode?: 'success' | 'error' | 'garbage' | 'empty' | 'incomplete' | 'crash' | 'sleep' | 'grandchild' | 'flood';
  readonly version?: string;
  readonly execHelp?: string;
  readonly loggedIn?: boolean;
  readonly result?: string;
  readonly plannerResult?: string;
  readonly reviewerResult?: string;
  /** Files the fake worker writes (relative to its working directory). */
  readonly writes?: Readonly<Record<string, string>>;
  readonly secretEcho?: string;
  /** Message of the failed turn in `error` mode. */
  readonly failMessage?: string;
  readonly marker?: string;
}

export interface Invocation {
  readonly argv: string[];
  readonly stdin: string;
  readonly cwd: string;
  readonly role: 'planner' | 'reviewer' | 'worker';
}

export interface FakeCodex {
  /** The npm-style `codex.cmd` launcher (what FORGE_CODEX_EXECUTABLE points at). */
  readonly launcher: string;
  configure(config: FakeCodexConfig): Promise<void>;
  resolve(name: string): Promise<ExecutableResolution>;
  lastInvocation(role?: Invocation['role']): Promise<Invocation>;
  calls(role: Invocation['role']): Promise<number>;
}

/** Installs the fake Codex CLI like an npm global install on Windows: script plus cmd-shim launcher. */
export async function installFakeCodex(temp: TempDirs, config: FakeCodexConfig = {}): Promise<FakeCodex> {
  const binDir = join(await temp.make('forge-fake-codex-'), 'Program Files', 'fake codex');
  const packageDir = join(binDir, 'node_modules', '@fake', 'codex');
  await mkdir(packageDir, { recursive: true });
  await copyFile(FAKE_CODEX_SOURCE, join(packageDir, 'cli.mjs'));
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@fake\\codex\\cli.mjs" %*',
    '',
  ].join('\r\n');
  const launcher = join(binDir, 'codex.cmd');
  await writeFile(launcher, shim);
  const configure = (next: FakeCodexConfig): Promise<void> => writeFile(join(packageDir, 'fake-codex.config.json'), JSON.stringify(next));
  await configure(config);
  return {
    launcher,
    configure,
    resolve: (name) => resolveExecutable(name, { env: { PATH: binDir, PATHEXT: '.CMD' }, platform: 'win32' }),
    lastInvocation: async (role) =>
      JSON.parse(await readFile(join(packageDir, role === undefined ? 'codex-invocation.json' : `codex-${role}-invocation.json`), 'utf8')) as Invocation,
    calls: async (role) => Number(await readFile(join(packageDir, `codex-${role}-calls.txt`), 'utf8').catch(() => '0')),
  };
}
