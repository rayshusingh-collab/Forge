import { isForgeError } from '../core/errors.ts';
import { doctorCommand } from './commands/doctor.ts';
import { projectCommand } from './commands/project.ts';
import { ExitCode } from './types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from './types.ts';

/** Registered commands. New commands are added here. */
export const COMMANDS: readonly CliCommand[] = [projectCommand, doctorCommand];

/**
 * Parses top-level arguments and dispatches to a command.
 * Never throws for expected failures; always resolves to an exit code.
 */
export async function runCli(argv: readonly string[], context: CliContext): Promise<ExitCodeValue> {
  const [first, ...rest] = argv;

  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    context.stdout.write(renderHelp(context.version));
    return ExitCode.Success;
  }
  if (first === '--version' || first === '-v') {
    context.stdout.write(`${context.version}\n`);
    return ExitCode.Success;
  }

  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (command === undefined) {
    const kind = first.startsWith('-') ? 'option' : 'command';
    context.stderr.write(`forge: unknown ${kind} "${first}"\nRun "forge --help" for usage.\n`);
    return ExitCode.Usage;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    context.stdout.write(`${command.summary}\n\nUsage: ${command.usage}\n`);
    return ExitCode.Success;
  }

  try {
    return await command.run(rest, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isForgeError(error)) {
      // Expected failure with a user-facing message; details only at debug level.
      context.logger.debug(`Command "${command.name}" failed`, { code: error.code, details: error.details });
    } else {
      context.logger.error(`Command "${command.name}" failed unexpectedly`, { error: message });
    }
    context.stderr.write(`forge ${command.name}: ${message}\n`);
    return ExitCode.Failure;
  }
}

export function renderHelp(version: string): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length));
  const commandLines = COMMANDS.map((command) => `  ${command.name.padEnd(width)}  ${command.summary}`);
  return [
    `Forge ${version} — local-first AI software-development orchestrator`,
    '',
    'Usage:',
    '  forge <command> [options]',
    '',
    'Commands:',
    ...commandLines,
    '',
    'Options:',
    '  -h, --help     Show help',
    '  -v, --version  Show version',
    '',
  ].join('\n');
}
