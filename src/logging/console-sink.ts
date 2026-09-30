import type { LogContext, LogRecord, LogSink } from './logger.ts';

export interface TextWriter {
  write(text: string): void;
}

/**
 * Renders a record as a single human-readable line:
 * `2026-01-01T12:00:00.000Z INFO  [scope] message key=value`
 */
export function formatLogRecord(record: LogRecord): string {
  const parts = [record.timestamp.toISOString(), record.level.toUpperCase().padEnd(5)];
  if (record.scope !== undefined) {
    parts.push(`[${record.scope}]`);
  }
  parts.push(record.message);
  const context = formatContext(record.context);
  if (context.length > 0) {
    parts.push(context);
  }
  return parts.join(' ');
}

function formatContext(context: LogContext): string {
  return Object.entries(context)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote only when needed so simple values stay readable.
    return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (value instanceof Error) {
    return JSON.stringify(value.message);
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  return String(value);
}

/**
 * Writes formatted records to a text stream. Defaults to stderr so that
 * stdout stays reserved for command output.
 */
export function createConsoleSink(writer: TextWriter = process.stderr): LogSink {
  return {
    write: (record) => writer.write(`${formatLogRecord(record)}\n`),
  };
}
