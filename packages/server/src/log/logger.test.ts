import { expect, test } from "vitest";
import { createLogger, type LoggerOptions } from "./logger";

function capture(options: LoggerOptions = {}) {
  const lines: string[] = [];
  const log = createLogger({
    write: (line) => lines.push(line),
    now: () => new Date("2026-11-22T10:00:00.000Z"),
    ...options,
  });
  return { log, lines };
}

test("writes one JSON object per line with time, level and message first", () => {
  const { log, lines } = capture();
  log.info("agent started", { agentId: "triage", attempt: 2 });

  expect(lines).toEqual([
    '{"time":"2026-11-22T10:00:00.000Z","level":"info","msg":"agent started","agentId":"triage","attempt":2}',
  ]);
});

test("keeps time, level and message when a field has the same name", () => {
  const { log, lines } = capture();
  log.warn("real", { level: "debug", msg: "fake", time: "never", kept: true });

  expect(JSON.parse(lines[0] ?? "")).toEqual({
    time: "2026-11-22T10:00:00.000Z",
    level: "warn",
    msg: "real",
    kept: true,
  });
});

test("drops records below the minimum level and writes the rest", () => {
  const { log, lines } = capture({ level: "warn" });
  log.debug("d");
  log.info("i");
  log.warn("w");
  log.error("e");

  expect(
    lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
  ).toEqual(["w", "e"]);
});

test("writes info and above by default", () => {
  const { log, lines } = capture();
  log.debug("d");
  log.info("i");

  expect(lines).toHaveLength(1);
});

test("writes a line for a message that isn't a string", () => {
  const { log, lines } = capture();
  log.info(42 as unknown as string);
  log.info(Symbol("x") as unknown as string);
  log.info({
    toJSON() {
      throw new Error("plain-message-error");
    },
  } as unknown as string);
  log.info({ toJSON: () => "Bearer abc123def456ghi" } as unknown as string);

  expect(
    lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
  ).toEqual(["42", "[Unreadable]", "[Unreadable]", "Bearer [REDACTED]"]);
});
