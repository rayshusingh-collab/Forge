import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

import { discoverProject } from '../projects/index.ts';
import type { LoadedProject } from '../projects/index.ts';
import { ExitCode } from './types.ts';
import type { CliContext, ExitCodeValue } from './types.ts';

type OptionsConfig = NonNullable<ParseArgsConfig['options']>;

export interface ParsedArgs {
  readonly values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  readonly positionals: string[];
}

/** Strict option parsing; reports errors on stderr and returns undefined (usage error). */
export function parseCommandArgs(
  command: string,
  args: readonly string[],
  context: CliContext,
  options: OptionsConfig,
): ParsedArgs | undefined {
  try {
    const { values, positionals } = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
    return { values: values as ParsedArgs['values'], positionals };
  } catch (error) {
    context.stderr.write(`forge ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

export function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanOption(parsed: ParsedArgs, name: string): boolean {
  return parsed.values[name] === true;
}

/** All values of a repeatable string option; each value may also be comma-separated. */
export function listOption(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.values[name];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** Exactly `count` positionals, or a usage error. */
export function expectPositionals(command: string, parsed: ParsedArgs, names: readonly string[], context: CliContext): string[] | undefined {
  if (parsed.positionals.length !== names.length) {
    const expected = names.length === 0 ? 'no arguments' : names.map((name) => `<${name}>`).join(' ');
    context.stderr.write(`forge ${command}: expected ${expected}\n`);
    return undefined;
  }
  return parsed.positionals;
}

/** The project containing the working directory, or an exit code after explaining. */
export async function requireProject(command: string, context: CliContext): Promise<LoadedProject | ExitCodeValue> {
  const project = await discoverProject(context.cwd);
  if (project === undefined) {
    context.stderr.write(
      `forge ${command}: no Forge project found at or above ${context.cwd}\n` + 'Register one with: forge project add <path>\n',
    );
    return ExitCode.Failure;
  }
  return project;
}
