import { defaultRules, redact, type RedactionRules } from "./redact";

export const levels = ["debug", "info", "warn", "error"] as const;

export type Level = (typeof levels)[number];

export type Fields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

export interface LoggerOptions {
  readonly level?: Level;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
  readonly rules?: RedactionRules;
}

export function createLogger({
  level: minimum = "info",
  write = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
  rules = defaultRules,
}: LoggerOptions = {}): Logger {
  const log =
    (level: Level) =>
    (msg: string, fields: Fields = {}): void => {
      if (levels.indexOf(level) < levels.indexOf(minimum)) return;
      const head = { time: now().toISOString(), level, msg };
      write(JSON.stringify(redact({ ...head, ...fields, ...head }, rules)));
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}
