import {
  defaultRules,
  redact,
  type RedactionRules,
  UNREADABLE,
} from "./redact";

export const levels = ["debug", "info", "warn", "error"] as const;

export type Level = (typeof levels)[number];

export type Fields = Readonly<Record<string, unknown>>;

const envelope = new Set(["time", "level", "msg"]);

function payloadEntries(payload: unknown): [string, unknown][] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return [["fields", payload]];
  }
  return Object.entries(payload).filter(([name]) => !envelope.has(name));
}

function messageText(msg: unknown, rules: RedactionRules): string {
  const redacted = redact(msg, rules);
  return typeof redacted === "string" ||
    typeof redacted === "number" ||
    typeof redacted === "boolean"
    ? String(redacted)
    : UNREADABLE;
}

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
      const record = Object.fromEntries([
        ["time", now().toISOString()],
        ["level", level],
        ["msg", messageText(msg, rules)],
        ...payloadEntries(redact(fields, rules)),
      ]);
      write(JSON.stringify(record));
    };
  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}
