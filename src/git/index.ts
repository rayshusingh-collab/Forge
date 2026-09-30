export { captureChanges, carryForwardBaseline, computeChanges, fingerprintPath, inScope, takeSnapshot, toBaseline } from './changes.ts';
export type { SnapshotEntry, WorktreeSnapshot } from './changes.ts';
export { GitClient } from './client.ts';
export type { GitClientOptions } from './client.ts';
export { DEFAULT_GIT_EXECUTABLE, findGitWorkTreeRoot } from './repository.ts';
export { parsePorcelainV2 } from './status.ts';
export type { GitStatus, StatusEntry, StatusEntryKind } from './status.ts';
