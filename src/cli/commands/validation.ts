import { stat } from 'node:fs/promises';

import { ValidationConfigError } from '../../core/errors.ts';
import { ProjectPathBoundary } from '../../projects/index.ts';
import type { LoadedProject } from '../../projects/index.ts';
import type { ValidationRecord } from '../../state/index.ts';
import { ValidationProfileStore, normalizeCheck, profileHash, resolveCheckExecutable, runValidation } from '../../validation/index.ts';
import type { ValidationCheck } from '../../validation/index.ts';
import { booleanOption, expectPositionals, parseCommandArgs, requireProject, stringOption } from '../args.ts';
import { createRunner, lenientConfig } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from '../types.ts';

const USAGE = [
  'forge validation <subcommand>',
  '',
  'Subcommands:',
  '  add --name <id> --executable <program> [--arg <value>]... [--cwd <dir>]',
  '      [--timeout <seconds>] [--optional] [-- <args>...]',
  '                     Add a deterministic check (a human-only operation)',
  '  list               List checks in the order they run',
  '  show <id>          Show one check and how its program resolves',
  '  remove <id>        Remove a check',
  '  run                Run all checks now against the working tree (records nothing)',
  '',
  '<program> is a name on PATH (e.g. npm), an absolute path, or a path inside the project',
  '(e.g. node_modules/.bin/tsc). Commands never run through a shell.',
  'Arguments starting with "-" go after "--", e.g.: --name test --executable npm -- test --silent',
].join('\n');

type Subcommand = (args: readonly string[], context: CliContext, project: LoadedProject) => Promise<ExitCodeValue>;

const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = { add, list, show, remove, run };

export const validationCommand: CliCommand = {
  name: 'validation',
  summary: 'Configure the deterministic checks that validate task results',
  usage: USAGE,
  async run(args, context) {
    const [name, ...rest] = args;
    const subcommand = name === undefined ? undefined : SUBCOMMANDS[name];
    if (subcommand === undefined) {
      const problem = name === undefined ? 'missing subcommand' : `unknown subcommand "${name}"`;
      context.stderr.write(`forge validation: ${problem}\n\nUsage: ${USAGE}\n`);
      return ExitCode.Usage;
    }
    const project = await requireProject(`validation ${name}`, context);
    if (typeof project === 'number') {
      return project;
    }
    return subcommand(rest, context, project);
  },
};

async function add(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('validation add', args, context, {
    name: { type: 'string' },
    executable: { type: 'string' },
    arg: { type: 'string', multiple: true },
    cwd: { type: 'string' },
    timeout: { type: 'string' },
    optional: { type: 'boolean' },
  });
  if (parsed === undefined) {
    return ExitCode.Usage;
  }
  const name = stringOption(parsed, 'name');
  const executable = stringOption(parsed, 'executable');
  if (name === undefined || executable === undefined) {
    context.stderr.write('forge validation add: --name and --executable are required\n');
    return ExitCode.Usage;
  }
  const timeout = stringOption(parsed, 'timeout');
  if (timeout !== undefined && !/^\d{1,6}$/.test(timeout.trim())) {
    context.stderr.write('forge validation add: --timeout must be a whole number of seconds\n');
    return ExitCode.Usage;
  }
  // `--arg` values keep their order; values after `--` are appended as-is.
  const rawArgs = parsed.values['arg'];
  const checkArgs = [...(Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === 'string') : []), ...parsed.positionals];

  const check = normalizeCheck({
    id: name,
    executable,
    args: checkArgs,
    cwd: stringOption(parsed, 'cwd') ?? '.',
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout.trim()) * 1000 }),
    required: !booleanOption(parsed, 'optional'),
  });
  // Verify now, so a typo is caught at configuration time rather than during a task.
  await verifyWorkingDirectory(project, check);
  const resolution = await resolveCheckExecutable(check, project);
  if (!resolution.ok) {
    throw new ValidationConfigError(`Cannot use "${check.executable}": ${resolution.message}`);
  }

  await new ValidationProfileStore(project.layout).addCheck(check);
  context.stdout.write(
    `Added ${check.required ? 'required' : 'optional'} check "${check.id}": ${describeCommand(check)}\n` +
      `  Program:  ${resolution.executable.source}\n  Timeout:  ${check.timeoutMs / 1000} s\n  Directory: ${check.cwd}\n`,
  );
  return ExitCode.Success;
}

async function list(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('validation list', args, context, {});
  if (parsed === undefined || expectPositionals('validation list', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const profile = await new ValidationProfileStore(project.layout).load();
  if (profile.checks.length === 0) {
    context.stdout.write(
      'No validation checks configured. Tasks will wait for validation until checks exist.\n' +
        'Add one with: forge validation add --name test --executable npm -- test\n',
    );
    return ExitCode.Success;
  }
  const rows = profile.checks.map((check, index) => [
    String(index + 1),
    check.id,
    check.required ? 'required' : 'optional',
    `${check.timeoutMs / 1000}s`,
    check.cwd,
    describeCommand(check),
  ]);
  context.stdout.write(table(['#', 'NAME', 'KIND', 'TIMEOUT', 'DIR', 'COMMAND'], rows));
  context.stdout.write(`Profile hash: ${profileHash(profile).slice(0, 16)}\n`);
  return ExitCode.Success;
}

async function show(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('validation show', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('validation show', parsed, ['id'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  const profile = await new ValidationProfileStore(project.layout).load();
  const check = profile.checks.find((candidate) => candidate.id === positionals[0]);
  if (check === undefined) {
    throw new ValidationConfigError(`No check named "${positionals[0]}"`);
  }
  const resolution = await resolveCheckExecutable(check, project);
  context.stdout.write(
    [
      `Check ${check.id} (${check.required ? 'required' : 'optional'})`,
      `  Executable: ${check.executable}`,
      `  Resolves to: ${resolution.ok ? `${resolution.executable.command} ${resolution.executable.prefixArgs.join(' ')}`.trim() : `NOT RESOLVABLE — ${resolution.message}`}`,
      `  Arguments:  ${check.args.length === 0 ? '(none)' : check.args.map((arg) => JSON.stringify(arg)).join(' ')}`,
      `  Directory:  ${check.cwd}`,
      `  Timeout:    ${check.timeoutMs / 1000} s`,
      '',
    ].join('\n'),
  );
  return ExitCode.Success;
}

async function remove(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('validation remove', args, context, {});
  const positionals = parsed === undefined ? undefined : expectPositionals('validation remove', parsed, ['id'], context);
  if (positionals === undefined) {
    return ExitCode.Usage;
  }
  await new ValidationProfileStore(project.layout).removeCheck(positionals[0]!);
  context.stdout.write(`Removed check "${positionals[0]}".\n`);
  return ExitCode.Success;
}

async function run(args: readonly string[], context: CliContext, project: LoadedProject): Promise<ExitCodeValue> {
  const parsed = parseCommandArgs('validation run', args, context, {});
  if (parsed === undefined || expectPositionals('validation run', parsed, [], context) === undefined) {
    return ExitCode.Usage;
  }
  const profile = await new ValidationProfileStore(project.layout).load();
  if (profile.checks.length === 0) {
    context.stdout.write('No validation checks configured.\n');
    return ExitCode.Failure;
  }
  const record = await runValidation(profile, {
    project,
    runner: createRunner(context, lenientConfig(context)),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  context.stdout.write(`${formatValidation(record)}Overall: ${record.status.toUpperCase()} (nothing was recorded)\n`);
  return record.status === 'passed' ? ExitCode.Success : ExitCode.Failure;
}

async function verifyWorkingDirectory(project: LoadedProject, check: ValidationCheck): Promise<void> {
  const authorized = await new ProjectPathBoundary(project.layout.root).authorize(check.cwd);
  const isDirectory = await stat(authorized.resolvedPath).then((info) => info.isDirectory()).catch(() => false);
  if (!authorized.exists || !isDirectory) {
    throw new ValidationConfigError(`Working directory "${check.cwd}" is not an existing directory in the project`);
  }
}

export function describeCommand(check: ValidationCheck): string {
  return [check.executable, ...check.args].map((part) => (/^[\w./:=@+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

/** Per-check lines, e.g. `  test         FAIL   8.4s  exited with code 1`. */
export function formatValidation(record: ValidationRecord): string {
  const width = Math.max(4, ...record.checks.map((check) => check.id.length));
  const lines = record.checks.map((check) => {
    const status = check.status === 'passed' ? 'PASS' : check.status === 'failed' ? 'FAIL' : check.status.toUpperCase();
    const duration = check.durationMs === null ? '' : `${(check.durationMs / 1000).toFixed(1)}s`;
    const optional = check.required ? '' : ' (optional)';
    const detail = check.status === 'passed' ? '' : `  ${check.diagnostic ?? ''}`;
    return `  ${check.id.padEnd(width)}  ${status.padEnd(7)} ${duration.padStart(6)}${optional}${detail}`.trimEnd();
  });
  return `${lines.join('\n')}\n`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const render = (row: readonly string[]): string =>
    row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]!))).join('  ').trimEnd();
  return `${[render(headers), ...rows.map(render)].join('\n')}\n`;
}
