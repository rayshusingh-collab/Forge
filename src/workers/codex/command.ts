import { isAbsolute } from 'node:path';

import { isWithin } from '../../projects/index.ts';
import type { WorkerAccessMode } from '../../state/index.ts';

/**
 * How Forge invokes the OpenAI Codex CLI (`codex exec`, non-interactive).
 * Every flag here was taken from the installed CLI's own `--help` output
 * (codex-cli 0.157.0) and verified with bounded live probes; see
 * docs/ARCHITECTURE.md ("Codex CLI provider").
 *
 * Safety mapping onto Forge's worker model:
 * - `--ignore-user-config` / `--ignore-rules`: the user's own Codex config can
 *   enable plugins, MCP servers, notify hooks and computer use. Forge never
 *   inherits them; it sets every behavior it relies on explicitly.
 * - Sandbox: `read-only` for read-only runs and AI roles; `workspace-write`
 *   for edit runs, with network access disabled and the temp directories
 *   removed from the writable roots, so writes outside the working directory
 *   are refused by Codex itself (Forge's own checks only see the project).
 *   The one exception is the run's scratch directory (see `scratch.ts`): a
 *   fresh directory Forge created outside the project, added as the only
 *   extra writable root so tool caches and temp files never land in the
 *   project or in `.forge/`.
 * - `approval_policy=never`: Codex never escalates out of the sandbox; a
 *   command the sandbox refuses simply fails and is reported to the model.
 * - Model-run shell commands get a minimal environment (`inherit=core`),
 *   plus the scratch variables (TMP/TEMP, package-manager caches) on edit runs.
 * - High-risk Codex features (apps, plugins, browser and computer use,
 *   multi-agent, hooks, worktrees, …) are disabled per invocation.
 * - AI roles (planner, reviewer) additionally disable command execution, so
 *   they work only from the input Forge sends.
 * - Dangerous options are never used (see FORBIDDEN_CODEX_OPTIONS).
 */

/** Codex features turned off for every Forge invocation (names from `codex features list`). */
export const CODEX_DISABLED_FEATURES = [
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'multi_agent',
  'tool_suggest',
  'skill_search',
  'hooks',
  'worktrees',
] as const;

/** Additionally disabled for AI roles: no command execution and no file viewing. */
export const CODEX_ROLE_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'view_image'] as const;

/** Options Forge must never pass (and refuses to build). */
export const FORBIDDEN_CODEX_OPTIONS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  'danger-full-access',
  '--approve-for-me',
  '--search',
  '--add-dir',
  '--worktree',
  '--remote',
  '--oss',
] as const;

/** `codex exec --help` must mention these for Forge to use the installed CLI. */
export const REQUIRED_CODEX_EXEC_OPTIONS = [
  '--json',
  '--sandbox',
  'workspace-write',
  'read-only',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--disable',
  '--config',
  '--cd',
] as const;

/** Forge-created scratch space for an edit run (see `scratch.ts`). */
export interface CodexScratch {
  readonly directory: string;
  readonly env: Readonly<Record<string, string>>;
}

export type CodexInvocation =
  | { readonly kind: 'worker'; readonly access: WorkerAccessMode; readonly workingDirectory: string; readonly scratch?: CodexScratch }
  | { readonly kind: 'role'; readonly workingDirectory: string };

/** Arguments after the executable. The prompt is always sent on stdin (`-`), never as an argument. */
export function buildCodexExecArgs(invocation: CodexInvocation): string[] {
  const edit = invocation.kind === 'worker' && invocation.access === 'edit';
  const scratch = invocation.kind === 'worker' ? invocation.scratch : undefined;
  if (scratch !== undefined) {
    assertSafeScratch(scratch, invocation.workingDirectory, edit);
  }
  const disabled = invocation.kind === 'role' ? [...CODEX_DISABLED_FEATURES, ...CODEX_ROLE_DISABLED_FEATURES] : [...CODEX_DISABLED_FEATURES];
  const args = [
    'exec',
    '--json',
    '--color',
    'never',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    ...(invocation.kind === 'role' ? ['--skip-git-repo-check'] : []),
    '--sandbox',
    edit ? 'workspace-write' : 'read-only',
    '--config',
    'approval_policy=never',
    // Ignored on other platforms; without the user's config Codex has no working Windows sandbox mode.
    '--config',
    'windows.sandbox=unelevated',
    '--config',
    'sandbox_workspace_write.network_access=false',
    '--config',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    '--config',
    'sandbox_workspace_write.exclude_slash_tmp=true',
    '--config',
    'shell_environment_policy.inherit=core',
    ...(scratch === undefined
      ? []
      : [
          '--config',
          `sandbox_workspace_write.writable_roots=[${tomlLiteral(scratch.directory)}]`,
          '--config',
          `shell_environment_policy.set={ ${Object.entries(scratch.env)
            .map(([name, value]) => `${name} = ${tomlLiteral(value)}`)
            .join(', ')} }`,
        ]),
    ...disabled.flatMap((feature) => ['--disable', feature]),
    '--cd',
    invocation.workingDirectory,
    '-',
  ];
  assertNoForbiddenCodexOptions(args);
  return args;
}

/**
 * The scratch directory becomes a writable root, so it must be an absolute
 * path outside the working directory (and must not contain it), used only
 * for edit runs. Every variable must point inside it or be a plain setting.
 */
function assertSafeScratch(scratch: CodexScratch, workingDirectory: string, edit: boolean): void {
  if (!edit) {
    throw new Error('Refusing to build a Codex invocation: scratch space is only for edit runs');
  }
  const { directory } = scratch;
  if (!isAbsolute(directory) || isWithin(workingDirectory, directory) || isWithin(directory, workingDirectory)) {
    throw new Error(`Refusing to build a Codex invocation: scratch directory ${directory} overlaps the working directory`);
  }
  for (const [name, value] of Object.entries(scratch.env)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`Refusing to build a Codex invocation: invalid scratch variable name ${name}`);
    }
    if (isAbsolute(value) ? !isWithin(directory, value) : !PLAIN_SETTING.test(value)) {
      throw new Error(`Refusing to build a Codex invocation: scratch variable ${name} points outside the scratch directory`);
    }
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_SETTING = /^[A-Za-z0-9_.-]{1,64}$/;

/** A TOML literal string: no escapes exist inside one, so quotes and control characters are refused. */
function tomlLiteral(value: string): string {
  if (/['\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Refusing to build a Codex invocation: unsupported character in ${JSON.stringify(value)}`);
  }
  return `'${value}'`;
}

function assertNoForbiddenCodexOptions(args: readonly string[]): void {
  for (const arg of args) {
    for (const forbidden of FORBIDDEN_CODEX_OPTIONS) {
      if (arg === forbidden || arg.startsWith(`${forbidden}=`)) {
        throw new Error(`Refusing to build a Codex invocation with forbidden option ${forbidden}`);
      }
    }
  }
}

/** Options of `codex exec --help` that Forge needs but the installed CLI lacks. */
export function findMissingCodexCapabilities(execHelp: string): string[] {
  return REQUIRED_CODEX_EXEC_OPTIONS.filter((option) => !execHelp.includes(option));
}

/** `codex-cli 0.157.0` -> `0.157.0`. */
export function parseCodexVersion(output: string): string | null {
  const match = /codex-cli\s+(\d+\.\d+\.\d+[\w.+-]*)/i.exec(output);
  return match?.[1] ?? null;
}

/**
 * `codex login status`: exit 0 with "Logged in …" when authenticated;
 * exit 1 with "Not logged in" when not. Anything else is unknown.
 * Only the verdict is kept; Forge never stores or prints the details.
 */
export function parseCodexLoginStatus(exitCode: number | null, output: string): boolean | null {
  if (/not logged in/i.test(output)) {
    return false;
  }
  if (exitCode === 0 && /logged in/i.test(output)) {
    return true;
  }
  return null;
}
