type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
  child: (fields: Record<string, unknown>) => Logger;
};

export const createLogger = (minLevel: Level = "info", base: Record<string, unknown> = {}): Logger => {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...fields }, jsonReplacer);
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger(minLevel, { ...base, ...fields }),
  };
};

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export const jsonReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value instanceof Error ? value.message : value;
