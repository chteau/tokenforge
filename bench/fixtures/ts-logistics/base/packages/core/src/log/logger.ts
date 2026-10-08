export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(opts: { level?: Level; base?: Record<string, unknown>; sink?: (line: string) => void } = {}): Logger {
  const min = ORDER[opts.level ?? ((process.env.LOG_LEVEL as Level) || 'info')] ?? 20;
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + '\n'));
  const base = opts.base ?? {};
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
