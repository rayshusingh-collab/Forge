import { randomUUID } from 'node:crypto';

import { ENV_VARS, ProjectConfigStore, SETTINGS, describeUnknownKey, effectiveSettings, isSettingKey, parseSettingValue } from '../../config/index.ts';
import { appendControlEvent } from '../../control/index.ts';
import { ProjectConfigError } from '../../core/errors.ts';
import { openStateStore } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import { expectPositionals, parseCommandArgs, requireProject } from '../args.ts';
import { formatEffectiveConfig } from '../control-format.ts';
import { requireConfig, resolveRegistries } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

const USAGE = [
  'forge config <subcommand>',
  '',
  'Subcommands:',
  '  show                 Effective configuration: value and source (project, environment, default)',
  '  get <key>            One effective value',
  '  set <key> <value>    Set a project override (typed, bounded; recorded)',
  '  reset <key>          Remove a project override (back to the default; recorded)',
  '  validate             Validate .forge/config.json',
  '',
  `Keys: ${Object.keys(SETTINGS).join(', ')}`,
  '',
  'Precedence: hard limits > command-line option > project configuration > environment > default.',
  'Configuration never stores credentials; use environment variables for those.',
].join('\n');

export const configCommand: CliCommand = {
  name: 'config',
  summary: 'Inspect and change the project configuration (.forge/config.json)',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      context.stderr.write(`forge config: ${name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`config ${name}`, context);
    return typeof project === 'number' ? project : subcommand(rest, context, project);
  },
};

type Subcommand = (args: readonly string[], context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { show, get, set, reset, validate };

function environment(context: CliContext): { workerTimeoutMs: number; workerTimeoutFromEnv: boolean } {
  const config = requireConfig(context);
  return { workerTimeoutMs: config.workerTimeoutMs, workerTimeoutFromEnv: (context.env[ENV_VARS.workerTimeoutMs] ?? '').trim() !== '' };
}

async function show(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('config show', args, context, {});
  if (parsed === undefined || expectPositionals('config show', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const store = new ProjectConfigStore(project.layout);
  const config = await store.load();
  context.stdout.write(`${formatEffectiveConfig(effectiveSettings(config, environment(context)))}File: ${store.file}${(await store.exists()) ? '' : ' (not created yet; all defaults)'}\n`);
  return ExitCode.Success;
}

async function get(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const key = singleKey('config get', args, context);
  if (key === undefined) {
    return ExitCode.Usage;
  }
  const setting = effectiveSettings(await new ProjectConfigStore(project.layout).load(), environment(context)).find((candidate) => candidate.key === key)!;
  context.stdout.write(`${String(setting.value ?? '-')}\t(${setting.source})\n`);
  return ExitCode.Success;
}

async function set(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('config set', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('config set', parsed, ['key', 'value'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const [key, text] = positionals as [string, string];
  if (!isSettingKey(key)) {
    throw new ProjectConfigError(describeUnknownKey(key));
  }
  const value = parseSettingValue(key, text);
  if (key.startsWith('providers.')) {
    assertKnownProvider(key, String(value), context);
  }
  const { previous } = await new ProjectConfigStore(project.layout).set(key, value);
  await recordChange(project, 'config-set', `${key}: ${String(previous ?? 'default')} -> ${String(value)}`);
  context.stdout.write(`${key} = ${String(value)} (project override; was ${String(previous ?? 'the default')})\n`);
  return ExitCode.Success;
}

async function reset(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  // Any key present in the file may be removed (even an invalid one), so a broken file can be repaired.
  const parsed = parseCommandArgs('config reset', args, context, {});
  const key = parsed === undefined ? undefined : expectPositionals('config reset', parsed, ['key'], context)?.[0];
  if (key === undefined) {
    return ExitCode.Usage;
  }
  const { previous } = await new ProjectConfigStore(project.layout).reset(key);
  if (previous !== undefined) {
    await recordChange(project, 'config-reset', `${key}: ${shown(previous)} -> default`);
  }
  context.stdout.write(previous === undefined ? `${key} had no project override.\n` : `${key} reset to the default (was ${shown(previous)}).\n`);
  return ExitCode.Success;
}

async function validate(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('config validate', args, context, {});
  if (parsed === undefined || expectPositionals('config validate', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const config = await new ProjectConfigStore(project.layout).load();
  context.stdout.write(`Configuration is valid (${Object.keys(config.settings).length} project override(s)).\n`);
  return ExitCode.Success;
}

function singleKey(command: string, args: readonly string[], context: CliContext): import('../../config/index.ts').SettingKey | undefined {
  const parsed = parseCommandArgs(command, args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals(command, parsed, ['key'], context);
  if (positionals === undefined) {
    return undefined;
  }
  const key = positionals[0]!;
  if (!isSettingKey(key)) {
    throw new ProjectConfigError(describeUnknownKey(key));
  }
  return key;
}

/** Configuration changes are human control actions; they appear in `forge audit`. */
async function recordChange(project: LoadedProject, kind: 'config-set' | 'config-reset', detail: string): Promise<void> {
  await openStateStore(project).update((state) => appendControlEvent(state, { id: randomUUID(), kind, reason: null, detail }, new Date()));
}

/** A previous value for display (bounded; it may come from an invalid, hand-edited file). */
function shown(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length <= 60 ? text : `${text.slice(0, 59)}…`;
}

/**
 * A provider role must name a provider that the registry for that role
 * knows (the implementer comes from the worker registry; the planner and
 * reviewer from the AI-role registry). Availability is NOT required here
 * (check it with `forge provider check`), but an unknown name is refused.
 */
function assertKnownProvider(key: string, name: string, context: CliContext): void {
  const registries = resolveRegistries(context);
  const registry = key === 'providers.implementer' ? registries.workers : registries.aiProviders;
  if (registry.create(name) === undefined) {
    const known = registry.list().flatMap((entry) => [entry.id, ...entry.aliases]);
    throw new ProjectConfigError(`${key}: unknown provider "${name}" (known for this role: ${known.join(', ')})`);
  }
}
