import { join } from 'node:path';

export const FORGE_DIR_NAME = '.forge';

/**
 * Written into `.forge/` so Git ignores all Forge metadata (including this
 * file) without Forge touching the project's own `.gitignore`.
 */
export const FORGE_GITIGNORE_CONTENT = '# Forge metadata is local to this machine.\n*\n';

/** Locations of Forge metadata inside a project root. */
export interface ForgeLayout {
  readonly root: string;
  readonly forgeDir: string;
  readonly projectFile: string;
  readonly stateFile: string;
  readonly lockFile: string;
  readonly gitignoreFile: string;
}

export function forgeLayout(root: string): ForgeLayout {
  const forgeDir = join(root, FORGE_DIR_NAME);
  return {
    root,
    forgeDir,
    projectFile: join(forgeDir, 'project.json'),
    stateFile: join(forgeDir, 'state.json'),
    lockFile: join(forgeDir, 'state.lock'),
    gitignoreFile: join(forgeDir, '.gitignore'),
  };
}
