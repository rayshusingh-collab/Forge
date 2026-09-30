import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { ProjectError } from '../core/errors.ts';
import { forgeLayout } from './layout.ts';
import { loadProject } from './metadata.ts';
import type { LoadedProject } from './metadata.ts';

/**
 * Finds the nearest Forge project at or above `start`, stopping at the
 * filesystem root. Returns `undefined` when there is none.
 *
 * - A `.forge` that is not a directory, or a directory without
 *   `project.json`, is not Forge metadata and is skipped.
 * - A `.forge` that is a link, or whose `project.json` is invalid or belongs
 *   to another location, is an error: it is never skipped silently and never
 *   trusted.
 */
export async function discoverProject(start: string): Promise<LoadedProject | undefined> {
  let current: string;
  try {
    current = await realpath(resolve(start));
  } catch (error) {
    throw new ProjectError(`Cannot search for a project from ${start}: path does not exist`, {
      details: { path: start },
      cause: error,
    });
  }

  for (;;) {
    if (await looksLikeForgeProject(current)) {
      return loadProject(current);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function looksLikeForgeProject(directory: string): Promise<boolean> {
  const layout = forgeLayout(directory);
  const forgeInfo = await lstat(layout.forgeDir).catch(() => undefined);
  if (forgeInfo === undefined) {
    return false;
  }
  if (forgeInfo.isSymbolicLink()) {
    return true; // loadProject rejects it with a clear error.
  }
  if (!forgeInfo.isDirectory()) {
    return false;
  }
  return (await lstat(layout.projectFile).catch(() => undefined)) !== undefined;
}
