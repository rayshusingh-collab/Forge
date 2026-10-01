import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ProjectConfigStore } from '../../config/index.ts';
import { checkRole } from '../../control/index.ts';
import { GitClient } from '../../git/index.ts';
import { forgeLayout, loadProject, registerProject } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { ValidationProfileStore } from '../../validation/index.ts';
import { parseCommandArgs, stringOption } from '../args.ts';
import { createRunner, requireConfig, resolveRegistries } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand } from '../types.ts';

const USAGE = [
  'forge init [<path>] [--name <name>] [--description <text>]',
  '',
  'Sets up (or re-checks) a Forge project in an existing Git work tree:',
  '  - registers it like `forge project add` (an existing registration is preserved)',
  '  - creates an empty project configuration (.forge/config.json) if there is none',
  '  - reports Git safety, validation checks, and provider availability',
  '  - SUGGESTS validation commands from package.json scripts (nothing is added or run)',
  '',
  'It never initializes Git, installs dependencies, runs project scripts, adds validation',
  'checks, or starts a worker.',
].join('\n');

/** package.json scripts that commonly validate a project, in the order they usually run. */
const SUGGESTED_SCRIPTS = ['typecheck', 'lint', 'test', 'build'];

export const initCommand: CliCommand = {
  name: 'init',
  summary: 'Set up a Forge project safely: register, default config, readiness report (no Git init, no installs)',
  usage: USAGE,
  async run(args, context) {
    const parsed = parseCommandArgs('init', args, context, { name: { type: 'string' }, description: { type: 'string' } });
    if (parsed === undefined || parsed.positionals.length > 1) {
      if (parsed !== undefined) {
        context.stderr.write(`forge init: expected at most one <path>\n\nUsage: ${USAGE}\n`);
      }
      return ExitCode.Usage;
    }
    const root = resolve(context.cwd, parsed.positionals[0] ?? '.');
    const config = requireConfig(context);
    const runner = createRunner(context, config);
    const lines: string[] = [];

    let project: LoadedProject;
    const existing = await lstat(forgeLayout(root).forgeDir).then(() => true).catch(() => false);
    if (existing) {
      project = await loadProject(root);
      lines.push(`Project "${project.project.name}" is already registered here; its registration and state were preserved.`);
    } else {
      const name = stringOption(parsed, 'name');
      const description = stringOption(parsed, 'description');
      try {
        project = await registerProject({
          path: root,
          cwd: context.cwd,
          runner,
          logger: context.logger.child('projects'),
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
        });
      } catch (error) {
        context.stderr.write(
          `forge init: ${error instanceof Error ? error.message : String(error)}\n` +
            'Forge only registers the root of an existing Git work tree. It never runs `git init` for you; do that yourself if you intend to.\n',
        );
        return ExitCode.Failure;
      }
      lines.push(`Registered project "${project.project.name}" (${project.project.id.slice(0, 8)}).`);
    }

    const configStore = new ProjectConfigStore(project.layout);
    lines.push((await configStore.createIfMissing()) ? `Created ${configStore.file} (no overrides: every setting uses its conservative default).` : `Kept the existing configuration ${configStore.file}.`);

    // Git safety.
    try {
      const status = await (await GitClient.create({ runner, root: project.layout.root })).status();
      const unmerged = status.entries.filter((entry) => entry.kind === 'unmerged').length;
      lines.push(
        `Git: ${status.head === null ? 'no commits yet (create an initial commit before autonomous work)' : `${status.branch ?? 'detached HEAD'} at ${status.head.slice(0, 12)}`}; ${status.entries.length === 0 ? 'clean' : `${status.entries.length} uncommitted change(s)`}${unmerged > 0 ? `; ${unmerged} UNRESOLVED CONFLICT(S)` : ''}`,
      );
    } catch (error) {
      lines.push(`Git: cannot read status (${error instanceof Error ? error.message : String(error)})`);
    }

    // Validation: existing checks, and suggestions only.
    const profile = await new ValidationProfileStore(project.layout).load();
    if (profile.checks.length > 0) {
      lines.push(`Validation: ${profile.checks.length} check(s) configured (${profile.checks.map((check) => check.id).join(', ')}).`);
    } else {
      lines.push('Validation: NO checks configured. Without required checks, every task stops for manual validation.');
      const suggestions = await suggestChecks(project.layout.root);
      if (suggestions.length > 0) {
        lines.push(
          '  Suggestions from package.json (NOT added — review each, then add it yourself if it is a trustworthy check):',
          ...suggestions.map((script) => `    forge validation add --name ${script} --executable npm -- run ${script}`),
        );
      } else {
        lines.push('  Add one with: forge validation add --name <id> --executable <program> -- <args>');
      }
    }

    // Providers (local checks only; no AI call).
    const registries = resolveRegistries(context);
    for (const role of ['implementer', 'planner', 'reviewer'] as const) {
      const health = await checkRole(role, registries, (await configStore.load()).settings);
      lines.push(`${role[0]!.toUpperCase()}${role.slice(1)}: ${health.configured} — ${health.available ? `available (${health.detail})` : `UNAVAILABLE (${health.detail})`}`);
    }

    lines.push('', 'Next: forge preflight · forge config show · forge plan create --goal "..."', 'Nothing was installed, run, committed, or started.');
    context.stdout.write(`${lines.join('\n')}\n`);
    return ExitCode.Success;
  },
};

/** Validation-like npm scripts present in package.json (by name only; never executed). */
async function suggestChecks(root: string): Promise<string[]> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts = manifest.scripts ?? {};
    return SUGGESTED_SCRIPTS.filter((name) => typeof scripts[name] === 'string');
  } catch {
    return [];
  }
}
