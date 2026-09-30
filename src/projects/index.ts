export { discoverProject } from './discovery.ts';
export { FORGE_DIR_NAME, FORGE_GITIGNORE_CONTENT, forgeLayout } from './layout.ts';
export type { ForgeLayout } from './layout.ts';
export { loadProject, openStateStore, writeProjectRecord } from './metadata.ts';
export type { LoadedProject } from './metadata.ts';
export {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  PROJECT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  decodeProjectRecord,
  normalizeProjectDescription,
  normalizeProjectName,
} from './model.ts';
export type { ProjectRecord, ProjectStatus } from './model.ts';
export {
  HOST_PATH_RULES,
  POSIX_PATH_RULES,
  ProjectPathBoundary,
  WINDOWS_PATH_RULES,
  isWithin,
  pathsEqual,
} from './path-boundary.ts';
export type { AuthorizedPath, PathRules } from './path-boundary.ts';
export { registerProject } from './registration.ts';
export type { RegisterProjectOptions, RegisteredProject } from './registration.ts';
