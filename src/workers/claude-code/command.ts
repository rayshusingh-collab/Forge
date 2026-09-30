import type { WorkerAccessMode } from '../../state/index.ts';

/**
 * Claude Code CLI invocation. Everything that depends on the installed CLI's
 * flags lives here, verified against Claude Code 2.1.x `--help`.
 *
 * Permission model (see README "Claude Code worker"):
 * - `--print` with `--output-format=json`: headless, single JSON result.
 * - `--restricted`: removes tools that run commands or code (Bash,
 *   PowerShell, REPL, ...) and WebFetch; confines file tools to the working
 *   directory; ignores user/project/local settings files (and so their hooks
 *   and permission rules); refuses bypassPermissions.
 * - `--tools=<list>`: only the listed built-in file tools exist for the run.
 * - `--permission-mode=acceptEdits`: file edits inside the working directory
 *   are applied without prompting (read-only runs get no edit tools at all).
 * - `--permission-prompts=none`: anything that would still need approval is
 *   denied automatically instead of hanging.
 * - `--strict-mcp-config` (with no config): no MCP servers.
 * - `--disable-slash-commands`: no skills.
 * - `--no-session-persistence`: the session is not saved for resumption.
 *
 * Never used: `--dangerously-skip-permissions`,
 * `--allow-dangerously-skip-permissions`, `--permission-mode=bypassPermissions`,
 * `--add-dir`, or any option that loads extra settings.
 */

/** Tools available in each access mode. None of them run commands. */
export const CLAUDE_TOOLS: Readonly<Record<WorkerAccessMode, readonly string[]>> = {
  'read-only': ['Read', 'Glob', 'Grep'],
  edit: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
};

/** Options the installed CLI must advertise in `--help` for Forge to use it. */
export const REQUIRED_CLAUDE_OPTIONS = [
  '--print',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--restricted',
  '--tools',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--append-system-prompt',
] as const;

/** Values that must appear in `--help` alongside the options above. */
const REQUIRED_CLAUDE_VALUES = ['acceptEdits', '"json"'] as const;

/** Options Forge must never pass; guarded in `buildClaudeArgs`. */
export const FORBIDDEN_CLAUDE_OPTIONS = [
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  'bypassPermissions',
  '--add-dir',
  '--settings',
  '--mcp-config',
  '--plugin-dir',
  '--plugin-url',
] as const;

export interface ClaudeArgsInput {
  readonly access: WorkerAccessMode;
  /** Forge's rules, delivered as an appended system prompt. */
  readonly instructions: string;
  readonly maxBudgetUsd?: number;
}

/**
 * Builds the argument list. The task itself is not an argument: it is sent on
 * stdin. Every valued option uses `--name=value`, so no value can be
 * mistaken for another option.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '--print',
    '--output-format=json',
    '--restricted',
    `--tools=${CLAUDE_TOOLS[input.access].join(',')}`,
    '--permission-mode=acceptEdits',
    '--permission-prompts=none',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    `--append-system-prompt=${input.instructions}`,
  ];
  if (input.maxBudgetUsd !== undefined) {
    args.push(`--max-budget-usd=${input.maxBudgetUsd}`);
  }
  assertNoForbiddenOptions(args);
  return args;
}

function assertNoForbiddenOptions(args: readonly string[]): void {
  for (const arg of args) {
    // The appended system prompt is Forge's own text and may mention anything.
    if (arg.startsWith('--append-system-prompt=')) {
      continue;
    }
    for (const forbidden of FORBIDDEN_CLAUDE_OPTIONS) {
      if (arg.includes(forbidden)) {
        throw new Error(`Refusing to pass forbidden Claude option: ${forbidden}`);
      }
    }
  }
}

/** Returns the required options/values missing from `claude --help` output. */
export function findMissingCapabilities(helpText: string): string[] {
  const missing: string[] = [];
  for (const option of REQUIRED_CLAUDE_OPTIONS) {
    const pattern = new RegExp(`(^|[\\s,])${option.replace(/-/g, '\\-')}(?![\\w-])`, 'm');
    if (!pattern.test(helpText)) {
      missing.push(option);
    }
  }
  for (const value of REQUIRED_CLAUDE_VALUES) {
    if (!helpText.includes(value)) {
      missing.push(value);
    }
  }
  return missing;
}

/** Extracts `2.1.285` from output such as `2.1.285 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | null {
  return /^\s*v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)?.[1] ?? null;
}

/**
 * Reads only `loggedIn` from `claude auth status --json`. Other fields
 * (email, organization) are deliberately ignored so they are never logged
 * or stored.
 */
export function parseAuthStatus(output: string): boolean | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed && typeof parsed.loggedIn === 'boolean') {
      return parsed.loggedIn;
    }
  } catch {
    // Fall through: unknown.
  }
  return null;
}
