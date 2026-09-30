/**
 * Lightweight logging abstraction.
 *
 * A `Logger` builds `LogRecord`s and hands them to a `LogSink`. Formatting and
 * destination live entirely in sinks, so structured or file logging can be
 * added later as new sinks without touching call sites.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export type LogContext = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly timestamp: Date;
  readonly level: LogLevel;
  /** Component that produced the record, e.g. `execution`. */
  readonly scope: string | undefined;
  readonly message: string;
  /** Already redacted; safe to render. */
  readonly context: LogContext;
}

export interface LogSink {
  write(record: LogRecord): void;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger sharing this one's level and sink, tagged with a scope. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly sink: LogSink;
  readonly scope?: string;
  /** Injected for deterministic tests. */
  readonly clock?: () => Date;
}

/**
 * Context keys whose values are replaced before reaching any sink. This is a
 * safety net, not a licence to pass secrets to the logger.
 */
const SENSITIVE_KEY_PATTERN = /pass(word)?|secret|token|api[-_]?key|auth|credential|cookie|private[-_]?key/i;

export const REDACTED = '[REDACTED]';

export function redactContext(context: LogContext): LogContext {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : value;
  }
  return result;
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, sink, scope } = options;
  const clock = options.clock ?? (() => new Date());
  const threshold = LEVEL_SEVERITY[level];

  const log = (recordLevel: LogLevel, message: string, context?: LogContext): void => {
    if (LEVEL_SEVERITY[recordLevel] < threshold) {
      return;
    }
    sink.write({
      timestamp: clock(),
      level: recordLevel,
      scope,
      message,
      context: context === undefined ? {} : redactContext(context),
    });
  };

  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
    child: (childScope) =>
      createLogger({
        ...options,
        scope: scope === undefined ? childScope : `${scope}:${childScope}`,
      }),
  };
}

/** A logger that discards everything; useful as a default dependency. */
export const silentLogger: Logger = createLogger({ level: 'error', sink: { write: () => {} } });
