import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveExecutable } from '../src/execution/index.ts';
import type { ExecutableResolution } from '../src/execution/index.ts';
import { registerProject } from '../src/projects/index.ts';
import type { LoadedProject } from '../src/projects/index.ts';
import type {
  Worker,
  WorkerExecuteOptions,
  WorkerHealth,
  WorkerRegistry,
  WorkerRequest,
  WorkerResult,
} from '../src/workers/index.ts';
import { TempDirs, initGitRepo, testRunner } from './fixtures.ts';

const FAKE_CLAUDE_SOURCE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

export interface FakeClaudeConfig {
  readonly mode?: 'success' | 'error' | 'garbage' | 'crash' | 'sleep' | 'flood';
  readonly result?: string;
  readonly version?: string;
  readonly help?: string;
  readonly loggedIn?: boolean;
  readonly denials?: readonly { tool_name: string }[];
}

export interface FakeClaude {
  /** Directory (containing spaces) holding the npm-style `claude.cmd` launcher. */
  readonly binDir: string;
  /** The wrapped script, as npm would install it. */
  readonly scriptPath: string;
  configure(config: FakeClaudeConfig): Promise<void>;
  /** Resolves `claude` exactly as Forge does on Windows, but only within `binDir`. */
  resolve(name: string): Promise<ExecutableResolution>;
  lastInvocation(): Promise<{ argv: string[]; stdin: string; cwd: string }>;
}

/**
 * Installs the fake CLI the way `npm install -g` does on Windows: the script
 * under `node_modules/`, plus a cmd-shim launcher `claude.cmd`, all under a
 * directory whose path contains spaces.
 */
export async function installFakeClaude(temp: TempDirs, config: FakeClaudeConfig = {}): Promise<FakeClaude> {
  const binDir = join(await temp.make('forge-fake-claude-'), 'Program Files', 'fake claude');
  const packageDir = join(binDir, 'node_modules', '@fake', 'claude-code');
  await mkdir(packageDir, { recursive: true });
  const scriptPath = join(packageDir, 'cli.mjs');
  await copyFile(FAKE_CLAUDE_SOURCE, scriptPath);

  // Verbatim structure of an npm cmd-shim launcher.
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
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@fake\\claude-code\\cli.mjs" %*',
    '',
  ].join('\r\n');
  await writeFile(join(binDir, 'claude.cmd'), shim);

  const configure = (next: FakeClaudeConfig): Promise<void> =>
    writeFile(join(packageDir, 'fake-claude.config.json'), JSON.stringify(next));
  await configure(config);

  return {
    binDir,
    scriptPath,
    configure,
    resolve: (name) => resolveExecutable(name, { env: { PATH: binDir, PATHEXT: '.CMD' }, platform: 'win32' }),
    lastInvocation: async () =>
      JSON.parse(await readFile(join(packageDir, 'invocation.json'), 'utf8')) as { argv: string[]; stdin: string; cwd: string },
  };
}

/** A registered temporary project with a small README. */
export async function createTestProject(temp: TempDirs, name = 'demo'): Promise<LoadedProject> {
  const root = await initGitRepo(join(await temp.make('forge-worker-project-'), name));
  await writeFile(join(root, 'README.md'), '# Demo\n');
  return registerProject({ path: root, cwd: root, runner: testRunner });
}

/** Registry exposing the given workers by ID (and `alias` for the first one). */
export function fakeRegistry(...workers: Worker[]): WorkerRegistry {
  return {
    list: () => workers.map((worker, index) => ({ id: worker.id, aliases: index === 0 ? ['alias'] : [], displayName: worker.displayName })),
    create: (name) => workers.find((worker, index) => worker.id === name || (index === 0 && name === 'alias')),
  };
}

/** In-memory worker returning scripted results; records the requests it saw. */
export class FakeWorker implements Worker {
  readonly id: string;
  readonly displayName = 'Fake Worker';
  readonly capabilities = { editsFiles: false, runsCommands: false, structuredOutput: true };
  readonly requests: WorkerRequest[] = [];
  private readonly behave: (request: WorkerRequest, options: WorkerExecuteOptions) => Promise<Partial<WorkerResult>>;
  private readonly healthValue: WorkerHealth;

  constructor(
    behave: (request: WorkerRequest, options: WorkerExecuteOptions) => Promise<Partial<WorkerResult>> = async () => ({}),
    options: { id?: string; available?: boolean } = {},
  ) {
    this.id = options.id ?? 'fake';
    this.behave = behave;
    const available = options.available ?? true;
    this.healthValue = {
      workerId: this.id,
      available,
      version: available ? '1.0.0' : null,
      executable: available ? '/fake/worker' : null,
      authenticated: available ? true : null,
      checks: [{ name: 'executable', ok: available, detail: available ? '/fake/worker' : 'not found on PATH' }],
    };
  }

  async healthCheck(): Promise<WorkerHealth> {
    return this.healthValue;
  }

  async execute(request: WorkerRequest, options: WorkerExecuteOptions = {}): Promise<WorkerResult> {
    this.requests.push(request);
    const partial = await this.behave(request, options);
    return {
      workerId: this.id,
      requestId: request.id,
      outcome: 'success',
      summary: 'Fake work done.',
      startedAt: new Date().toISOString(),
      durationMs: 5,
      process: null,
      provider: {},
      diagnostics: [],
      ...partial,
    };
  }
}
