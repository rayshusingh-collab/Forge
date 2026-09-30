import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { ProjectError, StateError } from '../core/errors.ts';
import { SchemaViolation } from '../core/validation.ts';
import { StateStore, UnsupportedVersionError, readJsonDocument, serializeJson, upgradeDocument, writeFileAtomic } from '../state/index.ts';
import type { StateStoreOptions } from '../state/index.ts';
import { forgeLayout } from './layout.ts';
import type { ForgeLayout } from './layout.ts';
import { PROJECT_SCHEMA_VERSION, decodeProjectRecord } from './model.ts';
import type { ProjectRecord } from './model.ts';
import { pathsEqual } from './path-boundary.ts';

/** A project whose metadata has been read, validated, and matched to its location. */
export interface LoadedProject {
  readonly project: ProjectRecord;
  readonly layout: ForgeLayout;
}

/**
 * Loads and validates `<root>/.forge/project.json`. `root` must be canonical
 * (as produced by `realpath`). Metadata is untrusted: it must be well-formed,
 * of a supported version, and must name this exact root, so a `.forge`
 * directory copied from another project is refused.
 */
export async function loadProject(root: string): Promise<LoadedProject> {
  const layout = forgeLayout(root);
  await assertRealDirectory(layout.forgeDir);

  let raw: unknown;
  try {
    raw = await readJsonDocument(layout.projectFile, 'Project metadata');
  } catch (error) {
    throw asProjectError(error, layout);
  }
  if (raw === undefined) {
    throw new ProjectError(`No Forge project metadata at ${layout.projectFile}`, {
      details: { path: layout.projectFile },
    });
  }

  let project: ProjectRecord;
  try {
    project = decodeProjectRecord(upgradeDocument(raw, PROJECT_SCHEMA_VERSION), isAbsolute);
  } catch (error) {
    if (error instanceof SchemaViolation || error instanceof UnsupportedVersionError) {
      throw new ProjectError(`Project metadata is invalid (${layout.projectFile}): ${error.message}`, {
        details: { path: layout.projectFile },
        cause: error,
      });
    }
    throw error;
  }

  if (!pathsEqual(project.rootPath, root)) {
    throw new ProjectError(
      `Project metadata at ${layout.projectFile} was registered for ${project.rootPath}; ` +
        'it was moved or copied and will not be trusted',
      { details: { path: layout.projectFile, recordedRoot: project.rootPath, actualRoot: root } },
    );
  }
  return { project, layout };
}

/** Validates, then atomically writes project metadata. */
export async function writeProjectRecord(layout: ForgeLayout, project: ProjectRecord): Promise<void> {
  const roundTripped: unknown = JSON.parse(JSON.stringify(project));
  decodeProjectRecord(roundTripped, isAbsolute);
  await writeFileAtomic(layout.projectFile, serializeJson(project));
}

export function openStateStore(
  loaded: LoadedProject,
  options: Pick<StateStoreOptions, 'clock' | 'lockTimeoutMs'> = {},
): StateStore {
  return new StateStore({
    ...options,
    stateFile: loaded.layout.stateFile,
    lockFile: loaded.layout.lockFile,
    projectId: loaded.project.id,
  });
}

/** `.forge` must be a real directory: following a link could put metadata writes outside the project. */
async function assertRealDirectory(forgeDir: string): Promise<void> {
  let info;
  try {
    info = await lstat(forgeDir);
  } catch (error) {
    throw new ProjectError(`No Forge metadata directory at ${forgeDir}`, { details: { path: forgeDir }, cause: error });
  }
  if (info.isSymbolicLink()) {
    throw new ProjectError(`${forgeDir} is a symbolic link or junction; refusing to use it`, {
      details: { path: forgeDir },
    });
  }
  if (!info.isDirectory()) {
    throw new ProjectError(`${forgeDir} is not a directory`, { details: { path: forgeDir } });
  }
}

function asProjectError(error: unknown, layout: ForgeLayout): unknown {
  if (error instanceof StateError) {
    return new ProjectError(`Project metadata is unreadable: ${error.message}`, {
      details: { path: layout.projectFile },
      cause: error,
    });
  }
  return error;
}
