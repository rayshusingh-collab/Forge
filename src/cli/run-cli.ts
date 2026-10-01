import { redactSecrets, secretValues } from '../core/redaction.ts';
import { isForgeError } from '../core/errors.ts';
import { doctorCommand } from './commands/doctor.ts';
import { milestoneCommand } from './commands/milestone.ts';
import { planCommand } from './commands/plan.ts';
import { runCommand } from './commands/run.ts';
import { approvalCommand } from './commands/approval.ts';
import { configCommand } from './commands/config.ts';
import { auditCommand, explainCommand, pauseCommand, preflightCommand, resumeCommand, statusCommand } from './commands/control.ts';
import { initCommand } from './commands/init.ts';
import { providerCommand } from './commands/provider.ts';
import { projectCommand } from './commands/project.ts';
import { taskCommand } from './commands/task.ts';
import { validationCommand } from './commands/validation.ts';
import { workerCommand } from './commands/worker.ts';
import { ExitCode } from './types.ts';
import type { CliCommand, CliContext, ExitCodeValue } from './types.ts';

/** Registered commands. New commands are added here. */
export const COMMANDS: readonly CliCommand[] = [
  initCommand,
  projectCommand,
  statusCommand,
  planCommand,
  milestoneCommand,
  taskCommand,
  runCommand,
  approvalCommand,
  pauseCommand,
  resumeCommand,
  explainCommand,
  auditCommand,
  preflightCommand,
  configCommand,
  validationCommand,
  providerCommand,
  workerCommand,
  doctorCommand,
];

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
    // Never print credential values that happen to appear in a message.
    const secrets = secretValues(context.env);
    const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    if (isForgeError(error)) {
      // Expected failure with an actionable, user-facing message; details only at debug level.
      context.logger.debug(`Command "${command.name}" failed`, { code: error.code });
      context.stderr.write(`forge ${command.name}: ${message}\n`);
    } else {
      // Unexpected: not swallowed, but no stack trace unless debug logging is on.
      const stack = error instanceof Error && error.stack !== undefined ? redactSecrets(error.stack, secrets) : message;
      context.logger.debug(`Command "${command.name}" failed unexpectedly`, { stack });
      context.stderr.write(
        `forge ${command.name}: internal error: ${message}\n` +
          'This is not an expected failure. Nothing further was attempted; inspect the project with `forge status`.\n' +
          'For diagnostics, re-run with FORGE_LOG_LEVEL=debug.\n',
      );
    }
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
