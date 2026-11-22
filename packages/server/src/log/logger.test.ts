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

test("redacts a string message, writes numbers and booleans as text, and nothing else", () => {
  const { log, lines } = capture();
  const messages: unknown[] = [
    "Bearer abc123def456ghi",
    42,
    true,
    12345678901234567890n,
    Symbol("x"),
    new Uint8Array(2),
    { toJSON: () => true },
    { toJSON: () => "Bearer abc123def456ghi" },
    {
      toJSON() {
        throw new Error("plain-message-error");
      },
    },
  ];
  for (const msg of messages) log.info(msg as never);

  expect(
    lines.map((line) => (JSON.parse(line) as { msg: string }).msg),
  ).toEqual([
    "Bearer [REDACTED]",
    "42",
    "true",
    "[Unreadable]",
    "[Unreadable]",
    "[Unreadable]",
    "[Unreadable]",
    "[Unreadable]",
    "[Unreadable]",
  ]);
});

test("accepts only fixed text as a message, at compile time", () => {
  const { log, lines } = capture();
  const user = String(lines.length);
  const flag = lines.length === 0;
  const name = "triage";

  log.info("user signed in", { user });
  log.warn(flag ? "cache cold" : "cache warm");
  log.error(`agent ${name} stopped`);
  // @ts-expect-error A message held in a variable isn't fixed text.
  log.debug(user);
  // @ts-expect-error A template with a value in it isn't fixed text.
  log.info(`user ${user} signed in`);
  // @ts-expect-error One branch isn't fixed text.
  log.warn(flag ? "cache cold" : `cache ${user}`);
  // @ts-expect-error A string built at run time isn't fixed text.
  log.error(String(flag));

  expect(lines).toHaveLength(6);
});
