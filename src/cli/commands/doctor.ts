import { runDoctor } from '../../core/doctor.ts';
import type { DoctorReport } from '../../core/doctor.ts';
import { resolveWorkers } from '../runtime.ts';
import { ExitCode } from '../types.ts';
import type { CliCommand } from '../types.ts';

export const doctorCommand: CliCommand = {
  name: 'doctor',
  summary: 'Check that the local Forge runtime is healthy',
  usage: 'forge doctor',
  async run(args, context) {
    if (args.length > 0) {
      context.stderr.write(`forge doctor: unexpected argument "${args[0]}"\nUsage: ${doctorCommand.usage}\n`);
      return ExitCode.Usage;
    }

    const registry = resolveWorkers(context, { lenient: true });
    const workers = registry
      .list()
      .map((descriptor) => registry.create(descriptor.id))
      .filter((worker) => worker !== undefined);

    const report = await runDoctor({
      nodeVersion: context.nodeVersion,
      env: context.env,
      nodeExecutable: context.nodeExecutable,
      cwd: context.cwd,
      workers,
      logger: context.logger.child('doctor'),
    });

    context.stdout.write(formatDoctorReport(report));
    return report.ok ? ExitCode.Success : ExitCode.Failure;
  },
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Forge doctor', ''];
  for (const check of report.checks) {
    const [firstLine = '', ...rest] = check.detail.split('\n');
    lines.push(`  [${check.status.toUpperCase()}] ${check.name}: ${firstLine}`);
    rest.forEach((line) => lines.push(`         ${line}`));
  }
  const failed = report.checks.filter((check) => check.status === 'fail').length;
  lines.push('', failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`);
  return `${lines.join('\n')}\n`;
}
