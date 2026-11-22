import { expect, test } from "vitest";
import { createLogger } from "./logger";
import { maskSecretValue } from "./masks";
import { REDACTED, redactText } from "./redact";

function logLine(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  createLogger({ write: (line) => lines.push(line) }).info("event", fields);
  return lines[0] ?? "";
}

test("masks a registered value in fields, errors, JSON and the message text", () => {
  maskSecretValue("Live9kQz-value-1");
  const line = logLine({
    field: "uses Live9kQz-value-1 here",
    error: new Error("failed with Live9kQz-value-1"),
    body: '{"note":"Live9kQz-value-1","user":"ada"}',
    neighbour: "Live9kQz-value-2",
  });

  expect(line).not.toContain("Live9kQz-value-1");
  expect(JSON.parse(line)).toMatchObject({
    field: `uses ${REDACTED} here`,
    error: { message: `failed with ${REDACTED}` },
    body: `{"note":"${REDACTED}","user":"ada"}`,
    neighbour: "Live9kQz-value-2",
  });
  expect(line).toContain(`"stack":"Error: failed with ${REDACTED}`);
  expect(redactText("say Live9kQz-value-1")).toBe(`say ${REDACTED}`);
});

test("ignores values shorter than 8 characters", () => {
  maskSecretValue("Short7x");

  expect(redactText("a Short7x b")).toBe("a Short7x b");
});

test("masks a value that contains or overlaps another one as a whole", () => {
  maskSecretValue("Over1apA-base");
  maskSecretValue("Over1apA-base-extended");
  maskSecretValue("AAAA1111BBBB");
  maskSecretValue("BBBB2222CCCC");

  expect(redactText("x Over1apA-base-extended y")).toBe(`x ${REDACTED} y`);
  expect(redactText("x Over1apA-base y")).toBe(`x ${REDACTED} y`);
  expect(redactText("x AAAA1111BBBB2222CCCC y")).toBe(`x ${REDACTED} y`);
});

test("checks 1,000 registered values against a 1 MB line quickly", () => {
  const values = Array.from(
    { length: 1000 },
    (_, i) => `Bulk${String(i).padStart(4, "0")}-${"q".repeat(12)}`,
  );
  for (const value of values) maskSecretValue(value);
  const text = `${"ordinary text ".repeat(70_000)}${values[500] ?? ""} end`;

  const started = performance.now();
  const redacted = redactText(text);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(redacted).not.toContain(values[500]);
  expect(redacted.endsWith(`${REDACTED} end`)).toBe(true);
});
