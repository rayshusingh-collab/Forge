import { loadConfig } from '../config/index.ts';
import type { Environment } from '../config/index.ts';
import { ProcessRunner } from '../execution/index.ts';
import { DEFAULT_GIT_EXECUTABLE } from '../git/repository.ts';
import type { Logger } from '../logging/index.ts';
import { MIN_NODE_VERSION, isSupportedNodeVersion } from './node-version.ts';

/**
 * Local runtime health checks. Checks are read-only and side-effect free apart
 * from launching Node and Git once each (read-only) to prove they can run.
 */

export type CheckStatus = 'pass' | 'fail';

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly checks: readonly DoctorCheckResult[];
}

export interface DoctorDependencies {
  /** Node version to evaluate, e.g. `process.version`. */
  readonly nodeVersion: string;
  readonly env: Environment;
  /** Executable used to exercise the process runner, normally `process.execPath`. */
  readonly nodeExecutable: string;
  /** Absolute directory the runner check executes in. */
  readonly cwd: string;
  /** Git executable; project registration requires Git. Defaults to `git` on PATH. */
  readonly gitExecutable?: string;
  readonly logger?: Logger;
}

/** Checks spawn trivial commands; this bounds them regardless of configuration. */
const RUNNER_CHECK_TIMEOUT_MS = 15_000;
const RUNNER_CHECK_MARKER = 'forge-doctor-ok';

export async function runDoctor(deps: DoctorDependencies): Promise<DoctorReport> {
  const checks = [
    checkNodeVersion(deps.nodeVersion),
    checkConfiguration(deps.env),
    await checkProcessRunner(deps),
    await checkGit(deps),
  ];
  return { ok: checks.every((check) => check.status === 'pass'), checks };
}

function checkNodeVersion(nodeVersion: string): DoctorCheckResult {
  const supported = isSupportedNodeVersion(nodeVersion);
  return {
    name: 'Node.js runtime',
    status: supported ? 'pass' : 'fail',
    detail: `${nodeVersion} (requires >= ${MIN_NODE_VERSION})`,
  };
}

function checkConfiguration(env: Environment): DoctorCheckResult {
  try {
    const config = loadConfig(env);
    return {
      name: 'Configuration',
      status: 'pass',
      detail: `mode=${config.mode} logLevel=${config.logLevel} processTimeoutMs=${config.processTimeoutMs}`,
    };
  } catch (error) {
    return { name: 'Configuration', status: 'fail', detail: describeError(error) };
  }
}

async function checkProcessRunner(deps: DoctorDependencies): Promise<DoctorCheckResult> {
  const name = 'Process runner';
  try {
    const result = await createRunner(deps).run({
      command: deps.nodeExecutable,
      args: ['-e', `process.stdout.write('${RUNNER_CHECK_MARKER}')`],
      cwd: deps.cwd,
    });
    if (result.outcome === 'success' && result.stdout === RUNNER_CHECK_MARKER) {
      return { name, status: 'pass', detail: `executed node in ${result.durationMs} ms` };
    }
    return {
      name,
      status: 'fail',
      detail: `unexpected result: outcome=${result.outcome} exitCode=${String(result.exitCode)}`,
    };
  } catch (error) {
    return { name, status: 'fail', detail: describeError(error) };
  }
}

async function checkGit(deps: DoctorDependencies): Promise<DoctorCheckResult> {
  const name = 'Git';
  try {
    const result = await createRunner(deps).run({
      command: deps.gitExecutable ?? DEFAULT_GIT_EXECUTABLE,
      args: ['--version'],
      cwd: deps.cwd,
    });
    if (result.outcome === 'success') {
      return { name, status: 'pass', detail: result.stdout.trim() };
    }
    const reason = result.outcome === 'spawn-error' ? 'not found on PATH' : `outcome=${result.outcome}`;
    return { name, status: 'fail', detail: `git --version failed (${reason}); Git is required to register projects` };
  } catch (error) {
    return { name, status: 'fail', detail: describeError(error) };
  }
}

function createRunner(deps: DoctorDependencies): ProcessRunner {
  return new ProcessRunner({
    defaultTimeoutMs: RUNNER_CHECK_TIMEOUT_MS,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
