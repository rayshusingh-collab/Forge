import { IntegrityError } from '../core/errors.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient, takeSnapshot } from '../git/index.ts';
import type { WorktreeSnapshot } from '../git/index.ts';
import { describeIntegrityChanges, snapshotControlState, verifyControlState } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';

/**
 * Wraps an AI role invocation that must not change anything: records the
 * project's working tree (Git view) and Forge's control metadata before,
 * and verifies both afterwards. Any difference is an integrity violation
 * and the role's result is discarded — nothing is persisted.
 *
 * Providers already run without tools in an empty directory; this is the
 * independent check. It cannot tell a concurrent human edit from an AI one,
 * so edits made during planning or review also abort the operation.
 */
export async function runReadOnly<T>(project: LoadedProject, runner: ProcessExecutor, action: () => Promise<T>): Promise<T> {
  const git = await GitClient.create({ runner, root: project.layout.root });
  const control = await snapshotControlState(project.layout, 'metadata');
  const before = await takeSnapshot(git);

  const result = await action();

  const integrity = await verifyControlState(project, control);
  const after = await takeSnapshot(git, before.entries.keys());
  const changed = worktreeDifferences(before, after);
  if (!integrity.ok || changed.length > 0) {
    const parts = [
      ...(integrity.ok ? [] : [`Forge metadata: ${describeIntegrityChanges(integrity)}`]),
      ...(changed.length === 0 ? [] : [`project files: ${changed.slice(0, 10).join(', ')}`]),
    ];
    throw new IntegrityError(
      `The project changed during a read-only AI operation (${parts.join('; ')}); the result was discarded and nothing was recorded`,
    );
  }
  return result;
}

function worktreeDifferences(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
  if (before.head !== after.head || before.branch !== after.branch) {
    return ['HEAD/branch'];
  }
  const changed: string[] = [];
  const paths = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const path of [...paths].sort()) {
    const a = before.entries.get(path);
    const b = after.entries.get(path);
    const aDirty = a?.dirty === true;
    const bDirty = b?.dirty === true;
    if (aDirty !== bDirty || (aDirty && (a!.fingerprint !== b!.fingerprint || a!.index !== b!.index || a!.indexHash !== b!.indexHash))) {
      changed.push(path);
    }
  }
  return changed;
}
