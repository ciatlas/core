export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

const ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

export interface LogRecord {
  level: Exclude<LogLevel, 'silent'>;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
  time: number;
}

/** Where log records go: e.g. lines on stderr, or the log commands of a GitHub Actions step. */
export interface LogSink {
  write(record: LogRecord): void;
  group?(title: string): void;
  groupEnd?(): void;
}

export interface Logger {
  readonly level: LogLevel;
  enabled(level: Exclude<LogLevel, 'silent'>): boolean;
  error(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  trace(message: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
  /** Runs `fn`, logging start/finish at debug level with the elapsed time. */
  time<T>(label: string, fn: () => T): T;
  group<T>(title: string, fn: () => T): T;
}

/**
 * flowpact's names, used when the embedding tool gives none: the scope of a logger created without one, and the
 * environment variable that turns on debug logging (see resolveLogLevel).
 */
const DEFAULTS = { scope: 'flowpact', debugEnv: 'FLOWPACT_DEBUG' } as const;

export function createLogger(options: { level?: LogLevel; sink?: LogSink; scope?: string } = {}): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? { write() {} };
  const scope = options.scope ?? DEFAULTS.scope;

  const log = (lvl: Exclude<LogLevel, 'silent'>, message: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] > ORDER[level]) return;
    sink.write({ level: lvl, scope, message, ...(data ? { data } : {}), time: Date.now() });
  };

  const logger: Logger = {
    level,
    enabled: (lvl) => ORDER[lvl] <= ORDER[level],
    error: (m, d) => log('error', m, d),
    warn: (m, d) => log('warn', m, d),
    info: (m, d) => log('info', m, d),
    debug: (m, d) => log('debug', m, d),
    trace: (m, d) => log('trace', m, d),
    child: (child) => createLogger({ level, sink, scope: `${scope}:${child}` }),
    time(label, fn) {
      const start = performance.now();
      log('trace', `${label} started`);
      try {
        return fn();
      } finally {
        log('debug', `${label} finished`, { ms: Math.round((performance.now() - start) * 100) / 100 });
      }
    },
    group(title, fn) {
      sink.group?.(title);
      try {
        return fn();
      } finally {
        sink.groupEnd?.();
      }
    },
  };
  return logger;
}

export const silentLogger: Logger = createLogger({ level: 'silent' });

/** Collects records in memory, e.g. for tests or debug dumps. */
export function memorySink(): LogSink & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { records, write: (r) => void records.push(r) };
}

/**
 * Resolves the effective log level from flags and environment.
 * `<debugEnv>=1` (`FLOWPACT_DEBUG` unless the tool names its own), `RUNNER_DEBUG=1` and `ACTIONS_STEP_DEBUG=true` all
 * enable debug; `<debugEnv>=trace` enables trace.
 */
export function resolveLogLevel(
  opts: { debug?: boolean; verbose?: number; quiet?: boolean; debugEnv?: string },
  env: Record<string, string | undefined> = process.env,
): LogLevel {
  if (opts.quiet) return 'error';
  if ((opts.verbose ?? 0) >= 2) return 'trace';
  const own = env[opts.debugEnv ?? DEFAULTS.debugEnv];
  const envDebug = truthy(own) || truthy(env.RUNNER_DEBUG) || truthy(env.ACTIONS_STEP_DEBUG);
  if (opts.debug || (opts.verbose ?? 0) >= 1 || envDebug) return own === 'trace' ? 'trace' : 'debug';
  return 'info';
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && ['1', 'true', 'yes', 'on', 'trace'].includes(v.toLowerCase());
}
