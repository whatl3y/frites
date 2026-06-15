// Structured, leveled, turn-scoped logging for the gateway. Writes one line per record to
// stdout so it lands in the service's StandardOutPath (~/.frites/gateway.log) — which is what
// `frites logs` tails — and is visible in the terminal when run in the foreground. Human format
// by default; set FRITES_LOG_JSON=1 for newline-delimited JSON.

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function isLogLevel(s: unknown): s is LogLevel {
  return typeof s === "string" && s in ORDER;
}

/** Resolve the effective level: FRITES_LOG_LEVEL env wins, then config, else "info". */
export function resolveLogLevel(configLevel?: string): LogLevel {
  const env = process.env.FRITES_LOG_LEVEL?.toLowerCase();
  if (isLogLevel(env)) return env;
  if (isLogLevel(configLevel)) return configLevel;
  return "info";
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  /** True when a record at this level would be emitted (guard expensive previews with it). */
  enabled(l: LogLevel): boolean;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps every record with the given fields (e.g. a turn id). */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  json?: boolean;
  /** Sink for finished lines (no trailing newline). Defaults to stdout. Injectable for tests. */
  write?: (line: string) => void;
  /** Timestamp source (ISO string). Injectable for tests. */
  now?: () => string;
  /** Fields stamped onto every record from this logger. */
  base?: LogFields;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const json = opts.json ?? process.env.FRITES_LOG_JSON === "1";
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = opts.now ?? (() => new Date().toISOString());
  const base = opts.base ?? {};
  const threshold = ORDER[level];

  function emit(l: LogLevel, msg: string, fields?: LogFields): void {
    if (ORDER[l] < threshold) return;
    const merged: LogFields = { ...base, ...(fields ?? {}) };
    write(json ? renderJson(now(), l, msg, merged) : renderText(now(), l, msg, merged));
  }

  return {
    level,
    enabled: (l) => ORDER[l] >= threshold,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...opts, level, json, base: { ...base, ...fields } }),
  };
}

function fmtVal(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? `"${v}"` : v;
  return JSON.stringify(v);
}

function renderText(ts: string, level: LogLevel, msg: string, fields: LogFields): string {
  const lvl = level.toUpperCase().padEnd(5);
  // `turn` is a first-class prefix so per-request lines are easy to scan and grep.
  const turn = typeof fields.turn === "string" ? `[${fields.turn}] ` : "";
  const rest = Object.entries(fields)
    .filter(([k, v]) => k !== "turn" && v !== undefined)
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join(" ");
  return `${ts} ${lvl} ${turn}${msg}${rest ? `  ${rest}` : ""}`;
}

function renderJson(ts: string, level: LogLevel, msg: string, fields: LogFields): string {
  return JSON.stringify({ ts, level, msg, ...fields });
}
