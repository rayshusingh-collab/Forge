import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { isWithin } from '../../projects/index.ts';

/**
 * Worker-owned scratch space for one sandboxed Codex edit run.
 *
 * Forge's workspace-write sandbox lets Codex write only to the working
 * directory (temp directories excluded, no network). Package managers still
 * need somewhere writable: npm writes a cache and `_logs/` on every
 * invocation, even `npm run`. With no sanctioned location the model
 * improvises one inside the project. In a real run it chose
 * `npm --cache .forge/npm-cache`, which is Git-ignored and so looked
 * harmless, but `.forge/` is Forge's control state and the run was
 * (correctly) stopped as an integrity violation.
 *
 * So each edit run gets a fresh, private directory outside the project. It
 * is added as the only extra writable root, the temp and package-manager
 * cache variables point into it, and it is removed afterwards. Nothing
 * written there is part of the project, so it never reaches change
 * attribution or commits.
 */

export const WORKER_SCRATCH_PREFIX = 'forge-codex-scratch-';

/** Environment variables pointed into the scratch directory, by subdirectory. */
const SCRATCH_DIRECTORIES: Readonly<Record<string, string>> = {
  TMP: 'tmp',
  TEMP: 'tmp',
  TMPDIR: 'tmp',
  npm_config_cache: 'npm-cache',
  YARN_CACHE_FOLDER: 'yarn-cache',
  // pnpm's own prefix: npm warns about an unknown `npm_config_store_dir` on every command.
  pnpm_config_store_dir: 'pnpm-store',
  XDG_CACHE_HOME: 'cache',
};

/** Plain settings: the update check needs the network the sandbox denies, and only writes cache files. */
const SCRATCH_SETTINGS: Readonly<Record<string, string>> = {
  npm_config_update_notifier: 'false',
};

export interface WorkerScratch {
  /** Absolute path of the directory Forge created for this run. */
  readonly directory: string;
  /** Variables for the sandboxed commands, all pointing inside `directory`. */
  readonly env: Readonly<Record<string, string>>;
  /** Removes the directory; never throws. */
  dispose(): Promise<void>;
}

export interface CreateWorkerScratchOptions {
  readonly projectRoot: string;
  /** Where the directory is created. Defaults to the OS temp directory. Injected for tests. */
  readonly parentDirectory?: string;
}

/**
 * Creates the scratch directory. Refuses (throws) when it would be inside
 * the project, lexically or after resolving links, e.g. when TEMP points into
 * the project. (A fresh `mkdtemp` child cannot contain the project.)
 */
export async function createWorkerScratch(options: CreateWorkerScratchOptions): Promise<WorkerScratch> {
  const parent = options.parentDirectory ?? tmpdir();
  if (!isAbsolute(parent) || !isAbsolute(options.projectRoot)) {
    throw new Error('Worker scratch and project paths must be absolute');
  }
  assertOutsideProject(parent, options.projectRoot);
  assertOutsideProject(await realpath(parent), await realpath(options.projectRoot));

  const directory = await mkdtemp(join(parent, WORKER_SCRATCH_PREFIX));
  const dispose = async (): Promise<void> => {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  };
  try {
    const env: Record<string, string> = { ...SCRATCH_SETTINGS };
    for (const [name, subdirectory] of Object.entries(SCRATCH_DIRECTORIES)) {
      const path = join(directory, subdirectory);
      await mkdir(path, { recursive: true });
      env[name] = path;
    }
    return { directory, env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function assertOutsideProject(parent: string, projectRoot: string): void {
  if (isWithin(projectRoot, parent)) {
    throw new Error(`Refusing to create worker scratch space in ${parent}: it is inside the project ${projectRoot}`);
  }
}
