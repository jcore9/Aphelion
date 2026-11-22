import { expect, test } from "vitest";
import { createLogger } from "./logger";
import { maskSecretValue, unmaskSecretValue } from "./masks";
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

test("masks a registered value used as a key, a number or a bigint", () => {
  maskSecretValue("Key9mask-value");
  maskSecretValue("31415926");
  maskSecretValue("27182818284590452353");
  const line = logLine({
    "Key9mask-value": "under a secret key",
    pin: 31415926,
    big: 27182818284590452353n,
    count: 1234,
    other: 27182818n,
  });

  expect(line).not.toContain("Key9mask-value");
  expect(line).not.toContain("31415926");
  expect(line).not.toContain("27182818284590452353");
  expect(JSON.parse(line)).toMatchObject({
    [REDACTED]: "under a secret key",
    pin: REDACTED,
    big: REDACTED,
    count: 1234,
    other: "27182818",
  });
  expect(redactText('{"pin":31415926,"n":7}')).toBe(
    `{"pin":"${REDACTED}","n":7}`,
  );
});

test("masks the base64, URI-encoded and JSON-escaped forms of a value", () => {
  const value = 'Enc0ded secret/with&"quote';
  expect(maskSecretValue(value)).toBe("masked");
  const forms = [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ];

  for (const form of forms) {
    expect(redactText(`x ${form} y`), form).toBe(`x ${REDACTED} y`);
  }
  expect(redactText("x enc0ded SECRET/with y")).toBe("x enc0ded SECRET/with y");
});

test("stops masking a value and its encoded forms once it is removed", () => {
  const value = "Remov3d secret/value";
  maskSecretValue(value);
  unmaskSecretValue(value);

  for (const form of [
    value,
    Buffer.from(value).toString("base64"),
    encodeURIComponent(value),
  ]) {
    expect(redactText(form)).toBe(form);
  }
});

test("keeps a value masked until every registration of it is removed", () => {
  const value = "Twice-registered-value";
  maskSecretValue(value);
  maskSecretValue(value);

  unmaskSecretValue(value);
  expect(redactText(`x ${value} y`)).toBe(`x ${REDACTED} y`);

  unmaskSecretValue(value);
  expect(redactText(`x ${value} y`)).toBe(`x ${value} y`);
});
