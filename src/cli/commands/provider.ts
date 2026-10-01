import { PROVIDER_ROLES, checkRole, roleProvider } from '../../control/index.ts';
import type { ProviderRole, RoleHealth } from '../../control/index.ts';
import { booleanOption, parseCommandArgs, stringOption } from '../args.ts';
import { formatRoleHealth } from '../control-format.ts';
import { loadProjectSettings, resolveRegistries } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';
import { discoverProject } from '../../projects/index.ts';
import type { ProjectSettings } from '../../config/index.ts';

const USAGE = [
  'forge provider <subcommand>',
  '',
  'Subcommands:',
  '  list                         Roles, the provider chosen for each, and the registered providers',
  '  check [--role <role>]        Health of the provider for each role (or one role)',
  '  check <provider> --role <r>  Health of a specific provider in a role',
  '',
  `Roles: ${PROVIDER_ROLES.join(', ')}. Checks are local (version, login); no AI call is made.`,
].join('\n');

export const providerCommand: CliCommand = {
  name: 'provider',
  summary: 'Inspect AI providers by role (planner, implementer, reviewer) and check their health',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    if (name === 'list') {
      return list(rest, context);
    }
    if (name === 'check') {
      return check(rest, context);
    }
    context.stderr.write(`forge provider: ${name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`}\n\nUsage: ${USAGE}\n`);
    return ExitCode.Usage;
  },
};

/** Project settings when run inside a project; defaults elsewhere (providers work without a project). */
async function settingsFor(context: CliContext): Promise<ProjectSettings> {
  const project = await discoverProject(context.cwd);
  return project === undefined ? {} : (await loadProjectSettings(project)).settings;
}

async function list(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('provider list', args, context, {});
  if (parsed === undefined || parsed.positionals.length > 0) {
    return ExitCode.Usage;
  }
  const settings = await settingsFor(context);
  const registries = resolveRegistries(context);
  const lines = ['ROLE         PROVIDER  SOURCE    REGISTRY'];
  for (const role of PROVIDER_ROLES) {
    const chosen = roleProvider(role, settings);
    lines.push(`${role.padEnd(11)}  ${chosen.name.padEnd(8)}  ${chosen.source.padEnd(8)}  ${role === 'implementer' ? 'workers' : 'AI roles'}`);
  }
  lines.push(
    '',
    `Workers (implementer): ${registries.workers.list().map((entry) => `${entry.id}${entry.aliases.length === 0 ? '' : ` (${entry.aliases.join(', ')})`}`).join(', ')}`,
    `AI roles (planner, reviewer): ${registries.aiProviders.list().map((entry) => `${entry.id}${entry.aliases.length === 0 ? '' : ` (${entry.aliases.join(', ')})`}`).join(', ')}`,
    'Change a role with: forge config set providers.<role> <provider>',
  );
  context.stdout.write(`${lines.join('\n')}\n`);
  return ExitCode.Success;
}

async function check(args: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('provider check', args, context, { role: { type: 'string' }, json: { type: 'boolean' } });
  if (parsed === undefined || parsed.positionals.length > 1) {
    return ExitCode.Usage;
  }
  const roleText = stringOption(parsed, 'role');
  if (roleText !== undefined && !(PROVIDER_ROLES as readonly string[]).includes(roleText)) {
    context.stderr.write(`forge provider check: --role must be one of ${PROVIDER_ROLES.join(', ')}\n`);
    return ExitCode.Usage;
  }
  const named = parsed.positionals[0];
  if (named !== undefined && roleText === undefined) {
    context.stderr.write('forge provider check: give --role with a provider name (the same name may exist in several registries)\n');
    return ExitCode.Usage;
  }
  const settings = await settingsFor(context);
  const registries = resolveRegistries(context);
  const roles: ProviderRole[] = roleText === undefined ? [...PROVIDER_ROLES] : [roleText as ProviderRole];
  const results: RoleHealth[] = [];
  for (const role of roles) {
    results.push(await checkRole(role, registries, settings, named));
  }
  if (booleanOption(parsed, 'json')) {
    context.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    context.stdout.write(formatRoleHealth(results));
  }
  if (results.some((result) => !result.available)) {
    context.stdout.write('An unavailable provider blocks only the commands that need its role.\n');
  }
  return results.every((result) => result.available) ? ExitCode.Success : ExitCode.Failure;
}
