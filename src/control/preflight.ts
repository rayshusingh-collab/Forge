import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import { ProjectConfigStore } from '../config/index.ts';
import type { ProjectConfig } from '../config/index.ts';
import type { ProcessExecutor } from '../execution/index.ts';
import { GitClient } from '../git/index.ts';
import { readLeaseStatus } from '../orchestration/lease.ts';
import { FORGE_GITIGNORE_CONTENT, ProjectPathBoundary, snapshotControlState } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import type { OrchestrationPolicy, ProjectState, StateStore } from '../state/index.ts';
import { deriveWorkflow, processLiveness } from '../tasks/index.ts';
import type { ExecutorLiveness } from '../tasks/index.ts';
import { ValidationProfileStore } from '../validation/index.ts';
import { checkRole } from './providers.ts';
import type { ProviderRole, Registries } from './providers.ts';

/**
 * Preflight: one read-only health report for a project, used by
 * `forge preflight`, `forge status`, and — for its CRITICAL checks — by
 * `forge run`, which refuses to start while any critical check fails.
 *
 * Statuses: PASS (fine), WARN (works, but a human should know or act),
 * FAIL (unsafe or impossible; for critical checks, autonomous runs refuse).
 * A WARN is never upgraded to PASS: it stays visible in every report.
 *
 * Nothing here writes state, configuration, files, or Git (Git is queried
 * with optional locks disabled). Provider checks launch local processes
 * (version / login status) but make no AI call.
 */

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  readonly id: string;
  readonly title: string;
  readonly status: PreflightStatus;
  readonly detail: string;
  /** What a human should do, when anything. */
  readonly action: string | null;
  /** Critical checks gate autonomous runs. */
  readonly critical: boolean;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  /** No check failed. */
  readonly ok: boolean;
  /** No CRITICAL check failed (what `forge run` requires). */
  readonly runnable: boolean;
  /** Loaded along the way when valid, so callers need not read them again. */
  readonly state: ProjectState | null;
  readonly config: ProjectConfig | null;
}

export interface PreflightOptions {
  readonly project: LoadedProject;
  readonly store: StateStore;
  readonly runner: ProcessExecutor;
  /** When given, provider checks cover the roles this policy uses (reviewer / decision-maker only when enabled). */
  readonly policy?: OrchestrationPolicy;
  /** Omit to skip provider checks (e.g. when no process should be launched). */
  readonly registries?: Registries;
  readonly liveness?: ExecutorLiveness;
}

export async function runPreflight(options: PreflightOptions): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (check: Omit<PreflightCheck, 'action' | 'critical'> & { action?: string | null; critical?: boolean }): void => {
    checks.push({ action: null, critical: false, ...check });
  };
  const liveness = options.liveness ?? processLiveness;
  const { layout } = options.project;

  // Forge metadata.
  const metadataProblems = await protectedMetadataProblems(options.project);
  add({
    id: 'metadata',
    title: 'Forge metadata',
    status: metadataProblems.length === 0 ? 'pass' : 'fail',
    detail: metadataProblems.length === 0 ? `project "${options.project.project.name}" (${options.project.project.id.slice(0, 8)})` : metadataProblems.join('; '),
    action: metadataProblems.length === 0 ? null : 'Inspect .forge/ by hand; Forge never repairs its metadata automatically',
    critical: true,
  });

  // State.
  let state: ProjectState | null = null;
  try {
    state = await options.store.load();
    add({ id: 'state', title: 'State', status: 'pass', detail: `schema v${state.schemaVersion}, revision ${state.revision}, invariants hold`, critical: true });
  } catch (error) {
    add({ id: 'state', title: 'State', status: 'fail', detail: message(error), action: 'Inspect .forge/state.json; Forge refuses invalid state rather than repairing it', critical: true });
  }

  // Configuration.
  let config: ProjectConfig | null = null;
  try {
    config = await new ProjectConfigStore(layout).load();
    add({ id: 'config', title: 'Configuration', status: 'pass', detail: `${Object.keys(config.settings).length} project setting(s)`, critical: true });
  } catch (error) {
    add({ id: 'config', title: 'Configuration', status: 'fail', detail: message(error), action: 'Run `forge config validate`, then fix or reset the key', critical: true });
  }

  // Project boundary.
  try {
    const boundary = new ProjectPathBoundary(layout.root);
    const root = await boundary.authorize('.');
    const forge = await boundary.authorize('.forge');
    add({
      id: 'boundary',
      title: 'Project boundary',
      status: root.exists && forge.exists ? 'pass' : 'fail',
      detail: root.exists && forge.exists ? layout.root : 'the project root or .forge/ cannot be authorized',
      critical: true,
    });
  } catch (error) {
    add({ id: 'boundary', title: 'Project boundary', status: 'fail', detail: message(error), action: 'Check for links that leave the project', critical: true });
  }

  // Git.
  let git: GitClient | null = null;
  try {
    git = await GitClient.create({ runner: options.runner, root: layout.root });
    const status = await git.status();
    const unmerged = status.entries.filter((entry) => entry.kind === 'unmerged');
    if (unmerged.length > 0) {
      add({
        id: 'git',
        title: 'Git',
        status: 'fail',
        detail: `unresolved merge conflicts: ${unmerged.slice(0, 3).map((entry) => entry.path).join(', ')}`,
        action: 'Resolve the conflicts (Forge never resolves them for you)',
        critical: true,
      });
    } else if (status.head === null || status.branch === null) {
      add({
        id: 'git',
        title: 'Git',
        status: 'warn',
        detail: status.head === null ? 'the repository has no commits yet' : `HEAD is detached at ${status.head.slice(0, 12)}`,
        action: status.head === null ? 'Create an initial commit so changes can be attributed and committed' : 'Check out a branch before autonomous work',
        critical: true,
      });
    } else {
      const dirty = status.entries.length;
      add({
        id: 'git',
        title: 'Git',
        status: dirty === 0 ? 'pass' : 'warn',
        detail: `branch ${status.branch} at ${status.head.slice(0, 12)}; ${dirty === 0 ? 'clean working tree' : `${dirty} uncommitted change(s)`}`,
        action: dirty === 0 ? null : 'Uncommitted files that a task also edits become "mixed" and are never auto-committed; commit or stash your own work first',
        critical: true,
      });
    }
  } catch (error) {
    add({ id: 'git', title: 'Git', status: 'fail', detail: message(error), action: 'Install Git and make sure the project is a Git work tree', critical: true });
  }

  // Secret-file policy (best effort; path-based, not a secret scanner).
  if (git !== null) {
    try {
      const visible = new Set(await git.listFiles());
      const exposed = ['.env', '.env.local', '.env.production'].filter((path) => visible.has(path));
      add({
        id: 'secrets',
        title: 'Secret files',
        status: exposed.length === 0 ? 'pass' : 'warn',
        detail:
          exposed.length === 0
            ? 'no well-known secret files are tracked or unignored (path-based check only)'
            : `${exposed.join(', ')} is tracked or not ignored by Git (AI context still withholds it by name)`,
        action: exposed.length === 0 ? null : 'Add it to .gitignore (and remove it from the index if tracked); keep secrets in ignored files',
      });
    } catch (error) {
      add({ id: 'secrets', title: 'Secret files', status: 'warn', detail: `could not list files: ${message(error)}` });
    }
  }

  // Validation profile.
  try {
    const profile = await new ValidationProfileStore(layout).load();
    const required = profile.checks.filter((check) => check.required).length;
    add({
      id: 'validation',
      title: 'Validation',
      status: required > 0 ? 'pass' : 'warn',
      detail: required > 0 ? `${required} required check(s): ${profile.checks.map((check) => check.id).join(', ')}` : 'no required checks are configured',
      action: required > 0 ? null : 'Add checks with `forge validation add`; without them every task stops for manual validation',
    });
  } catch (error) {
    add({ id: 'validation', title: 'Validation', status: 'fail', detail: message(error), action: 'Fix .forge/validation.json with `forge validation`', critical: true });
  }

  // Human control: pause, lease, approvals, tasks.
  if (state !== null) {
    add({
      id: 'paused',
      title: 'Pause',
      status: state.pause === null ? 'pass' : 'fail',
      detail: state.pause === null ? 'not paused' : `paused since ${state.pause.pausedAt}: ${state.pause.reason}`,
      action: state.pause === null ? null : 'Resume with `forge resume --reason "..."` when ready',
      critical: true,
    });
  }
  const lease = await readLeaseStatus(layout);
  add({
    id: 'lease',
    title: 'Orchestration lease',
    status: lease.held ? 'fail' : 'pass',
    detail: !lease.held
      ? 'no orchestration run holds the project'
      : lease.owner === null
        ? 'held by an unknown owner'
        : `held by run ${lease.owner.runId.slice(0, 8)} (pid ${lease.owner.pid} on ${lease.owner.host})${lease.ownerAlive === false ? ' — that process no longer exists' : ''}`,
    action: !lease.held ? null : lease.ownerAlive === false ? 'Recover it with `forge run recover --reason "..."`' : 'Wait for the active run, or stop it with Ctrl+C in its terminal',
    critical: true,
  });
  const stateLock = await readStateLock(layout.lockFile);
  if (stateLock !== null) {
    const dead = stateLock.host === hostname() && !liveness({ pid: stateLock.pid, host: stateLock.host });
    add({
      id: 'state-lock',
      title: 'State lock',
      status: dead ? 'fail' : 'warn',
      detail: dead
        ? `held by pid ${stateLock.pid}, which no longer exists (a Forge command crashed while writing)`
        : `held by pid ${stateLock.pid} on ${stateLock.host ?? 'an unknown host'} (a Forge command is writing state now)`,
      action: dead ? 'Recover it with `forge run recover --reason "..."`' : 'Wait for it to finish',
      critical: dead,
    });
  }
  if (state !== null) {
    const pending = state.approvals.filter((approval) => approval.status === 'pending');
    add({
      id: 'approvals',
      title: 'Approvals',
      status: pending.length === 0 ? 'pass' : 'warn',
      detail: pending.length === 0 ? 'none pending' : `${pending.length} pending: ${pending.slice(0, 5).map((approval) => `${approval.id.slice(0, 8)} (${approval.type})`).join(', ')}`,
      action: pending.length === 0 ? null : 'Inspect with `forge approval show <id>`, then approve or reject with a reason',
    });
    const view = deriveWorkflow(state, liveness);
    const attention = view.tasks.filter(
      (task) => task.condition === 'interrupted' || task.condition === 'awaiting-validation' || task.requiresIntegrityAcknowledgement,
    );
    add({
      id: 'tasks',
      title: 'Tasks',
      status: attention.length === 0 ? 'pass' : 'warn',
      detail:
        attention.length === 0
          ? `${view.tasks.length} task(s); ${view.runnable.length} runnable`
          : attention
              .slice(0, 5)
              .map((task) => `${task.key} ${task.requiresIntegrityAcknowledgement ? `${task.lastAttempt?.outcome} (acknowledgement required)` : task.condition}`)
              .join('; '),
      action: attention.length === 0 ? null : 'Use `forge explain` for the next safe step',
    });
  }

  // Providers.
  if (options.registries !== undefined && config !== null) {
    const settings = config.settings;
    const roles: { role: ProviderRole; override?: string; critical: boolean }[] = [
      { role: 'implementer', ...(options.policy === undefined ? {} : { override: options.policy.worker }), critical: true },
    ];
    if (options.policy === undefined || options.policy.review.enabled) {
      roles.push({ role: 'reviewer', ...(options.policy?.review.reviewer == null ? {} : { override: options.policy.review.reviewer }), critical: options.policy !== undefined });
    }
    // A run with auto-decision needs its decision-maker; there is no fallback to another provider.
    if (options.policy?.decision.enabled === true) {
      roles.push({ role: 'decision-maker', override: options.policy.decision.provider!, critical: true });
    } else if (options.policy === undefined && settings['run.autoDecide'] === true) {
      roles.push({ role: 'decision-maker', critical: false });
    }
    if (options.policy === undefined) {
      roles.push({ role: 'planner', critical: false });
    }
    for (const role of roles) {
      const health = await checkRole(role.role, options.registries, settings, role.override).catch((error: unknown) => ({
        role: role.role,
        configured: role.override ?? '?',
        available: false,
        detail: message(error),
      }));
      add({
        id: `provider-${role.role}`,
        title: role.role === 'decision-maker' ? 'Decision-maker' : `${role.role[0]!.toUpperCase()}${role.role.slice(1)}`,
        status: health.available ? 'pass' : role.critical ? 'fail' : 'warn',
        detail: `${health.configured}: ${health.detail}`,
        action: health.available ? null : `Check it with \`forge provider check --role ${role.role}\` and \`forge doctor\``,
        critical: role.critical,
      });
    }
  }

  return {
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
    runnable: checks.every((check) => !check.critical || check.status !== 'fail'),
    state,
    config,
  };
}

/** Problems with Forge's own protected files: the ignore file and links inside `.forge/`. */
async function protectedMetadataProblems(project: LoadedProject): Promise<string[]> {
  const problems: string[] = [];
  try {
    if ((await readFile(project.layout.gitignoreFile, 'utf8')) !== FORGE_GITIGNORE_CONTENT) {
      problems.push('.forge/.gitignore was modified (Forge metadata might be committed)');
    }
  } catch (error) {
    problems.push(`.forge/.gitignore is unreadable: ${message(error)}`);
  }
  try {
    const snapshot = await snapshotControlState(project.layout, 'full');
    const odd = [...snapshot.entries].filter(([, entry]) => entry.kind === 'link' || entry.kind === 'other' || entry.kind === 'unreadable');
    if (odd.length > 0) {
      problems.push(`unexpected entries in .forge/: ${odd.slice(0, 3).map(([path, entry]) => `${path} (${entry.kind})`).join(', ')}`);
    }
  } catch (error) {
    problems.push(`.forge/ cannot be inspected: ${message(error)}`);
  }
  return problems;
}

/** Owner of `.forge/state.lock`, or null when there is none (or it cannot be read). */
async function readStateLock(path: string): Promise<{ readonly pid: number; readonly host: string | null } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    return typeof value['pid'] === 'number' ? { pid: value['pid'], host: typeof value['host'] === 'string' ? value['host'] : null } : null;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
