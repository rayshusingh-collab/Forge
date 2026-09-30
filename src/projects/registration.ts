import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { ProjectError } from '../core/errors.ts';
import type { ProcessRunner } from '../execution/index.ts';
import { DEFAULT_GIT_EXECUTABLE, findGitWorkTreeRoot } from '../git/repository.ts';
import { silentLogger } from '../logging/index.ts';
import type { Logger } from '../logging/index.ts';
import { createInitialState } from '../state/index.ts';
import type { ProjectState } from '../state/index.ts';
import { FORGE_GITIGNORE_CONTENT, forgeLayout } from './layout.ts';
import { loadProject, openStateStore, writeProjectRecord } from './metadata.ts';
import type { LoadedProject } from './metadata.ts';
import { PROJECT_SCHEMA_VERSION, normalizeProjectDescription, normalizeProjectName } from './model.ts';
import type { ProjectRecord } from './model.ts';
import { pathsEqual } from './path-boundary.ts';

export interface RegisterProjectOptions {
  /** Directory to register; relative paths resolve against `cwd`. */
  readonly path: string;
  readonly cwd: string;
  /** Defaults to the directory name. */
  readonly name?: string;
  readonly description?: string;
  readonly runner: ProcessRunner;
  readonly gitExecutable?: string;
  readonly logger?: Logger;
  readonly clock?: () => Date;
  readonly generateId?: () => string;
}

export interface RegisteredProject extends LoadedProject {
  readonly state: ProjectState;
}

/**
 * Registers the root of an existing Git work tree as a Forge project by
 * creating `<root>/.forge/`. Nothing else in the project is created or
 * modified: Git is not initialized, configured, or committed to, and no
 * project scripts run.
 */
export async function registerProject(options: RegisterProjectOptions): Promise<RegisteredProject> {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? (() => new Date());
  const description = normalizeProjectDescription(options.description);

  const root = await canonicalDirectory(resolve(options.cwd, options.path));
  const name = normalizeProjectName(options.name ?? basename(root));

  const gitRoot = await canonicalDirectory(
    await findGitWorkTreeRoot(options.runner, root, options.gitExecutable ?? DEFAULT_GIT_EXECUTABLE),
  );
  if (!pathsEqual(gitRoot, root)) {
    throw new ProjectError(
      `${root} is inside the Git work tree ${gitRoot} but is not its root; register the work tree root instead`,
      { details: { path: root, gitRoot } },
    );
  }

  const layout = forgeLayout(root);
  await assertNotRegistered(layout.forgeDir, root);

  const now = clock();
  const project: ProjectRecord = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: (options.generateId ?? randomUUID)(),
    name,
    description,
    rootPath: root,
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  try {
    // Non-recursive mkdir fails if `.forge` appeared since the check above,
    // so two concurrent registrations cannot both proceed.
    await mkdir(layout.forgeDir);
  } catch (error) {
    throw new ProjectError(`Cannot create ${layout.forgeDir}`, { details: { path: layout.forgeDir }, cause: error });
  }

  let state: ProjectState;
  try {
    await writeFile(layout.gitignoreFile, FORGE_GITIGNORE_CONTENT, { flag: 'wx' });
    await writeProjectRecord(layout, project);
    state = await openStateStore({ project, layout }).create(createInitialState(project.id, now));
  } catch (error) {
    await removeCreatedMetadata(layout);
    throw error;
  }

  logger.info('Registered project', { projectId: project.id, name: project.name, root });
  return { project, layout, state };
}

async function canonicalDirectory(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new ProjectError(`Project path does not exist: ${path}`, { details: { path }, cause: error });
  }
  if (!info.isDirectory()) {
    throw new ProjectError(`Project path is not a directory: ${path}`, { details: { path } });
  }
  // Resolves links/junctions and yields canonical casing on Windows.
  return realpath(path);
}

async function assertNotRegistered(forgeDir: string, root: string): Promise<void> {
  try {
    await lstat(forgeDir);
  } catch {
    return; // Absent: safe to create.
  }
  let existing: LoadedProject;
  try {
    existing = await loadProject(root);
  } catch (error) {
    throw new ProjectError(
      `${forgeDir} already exists but is not valid Forge metadata for this project; refusing to modify it`,
      { details: { path: forgeDir }, cause: error },
    );
  }
  throw new ProjectError(`Project is already registered as "${existing.project.name}" (${existing.project.id})`, {
    details: { path: root, projectId: existing.project.id },
  });
}

/** Undoes a failed registration. Only removes files this registration created. */
async function removeCreatedMetadata(layout: ReturnType<typeof forgeLayout>): Promise<void> {
  for (const file of [layout.stateFile, layout.projectFile, layout.gitignoreFile]) {
    await unlink(file).catch(() => undefined);
  }
  await rmdir(layout.forgeDir).catch(() => undefined);
}
