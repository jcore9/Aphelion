import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { expect, onTestFinished, test } from "vitest";
import { createLogger, redact, REDACTED, redactText } from "../log";
import { openStore, type SqlValue } from "../store";
import {
  Secret,
  SecretConstructionError,
  SecretSerializationError,
  SecretWipedError,
} from ".";

function logLine(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  createLogger({ write: (line) => lines.push(line) }).info("event", fields);
  return lines[0] ?? "";
}

test("prints <redacted>, or the label, in every string form", () => {
  const plain = Secret.make("Print-value-0001");
  const labelled = Secret.make("Print-value-0002", { label: "GitHub token" });

  expect(String(plain)).toBe("<redacted>");
  // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
  expect(`${labelled}`).toBe("<redacted:GitHub token>");
  expect(`token ${String(plain)}`).toBe("token <redacted>");
  expect(inspect(plain)).toBe("<redacted>");
  expect(inspect({ nested: [labelled] })).toBe(
    "{ nested: [ <redacted:GitHub token> ] }",
  );
  expect(format("%s %o %O", plain, plain, labelled)).toBe(
    "<redacted> <redacted> <redacted:GitHub token>",
  );
  expect(new Error(`failed with ${String(labelled)}`).message).toBe(
    "failed with <redacted:GitHub token>",
  );
  expect(inspect(new Error("failed", { cause: plain }))).not.toContain(
    "Print-value-0001",
  );
});

test("refuses to be serialized as JSON or cloned", () => {
  const secret = Secret.make("Serial-value-0001");

  expect(() => JSON.stringify(secret)).toThrow(SecretSerializationError);
  expect(() => JSON.stringify({ deep: [{ secret }] })).toThrow(
    SecretSerializationError,
  );
  expect(() => structuredClone(secret)).toThrow(
    expect.objectContaining({ name: "DataCloneError" }),
  );
  expect(() => {
    new MessageChannel().port1.postMessage({ secret });
  }).toThrow(expect.objectContaining({ name: "DataCloneError" }));
  expect(JSON.stringify({ label: "no secret here" })).toBe(
    '{"label":"no secret here"}',
  );
});

test("turns into the placeholder when code writes it as text", async () => {
  const secret = Secret.make("Text-value-0001", { label: "Text" });

  expect(await new Blob([secret as unknown as string]).text()).toBe(
    "<redacted:Text>",
  );
  expect([secret].join(",")).toBe("<redacted:Text>");
});

test("copies nothing callable and can't be changed", () => {
  const secret = Secret.make("Spread-value-0001", { label: "Spread" });
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  const copies: object[] = [{ ...secret }, Object.assign({}, secret)];

  for (const copy of copies) {
    expect(Object.values(copy).some((v) => typeof v === "function")).toBe(
      false,
    );
    expect(JSON.stringify(copy)).toBe('{"label":"Spread"}');
  }
  expect(() => {
    delete (secret as { cloneGuard?: symbol }).cloneGuard;
  }).toThrow(TypeError);
  expect(() => structuredClone(secret)).toThrow(
    expect.objectContaining({ name: "DataCloneError" }),
  );
  expect(() => {
    (Secret.prototype as { reveal: () => string }).reveal = () => "x";
  }).toThrow(TypeError);
  expect(secret.reveal()).toBe("Spread-value-0001");
});

type AnyConstructor = new (...args: unknown[]) => Secret;

test("only Secret.make builds a Secret, so nothing else can unmask a value", () => {
  const value = "Factory-value-0001";
  const live = Secret.make(value);
  const Unchecked = Secret as unknown as AnyConstructor;
  class Subclass extends Unchecked {
    constructor() {
      super(Symbol("Secret.make"), value, undefined);
    }
  }
  const attempts = [
    () => {
      new Unchecked(value).wipe();
    },
    () => {
      new Unchecked(undefined, value).wipe();
    },
    () => {
      new Subclass().wipe();
    },
    () => {
      (Object.create(Secret.prototype) as Secret).wipe();
    },
    () => {
      Secret.prototype.wipe.call(Object.assign({}, live));
    },
  ];

  for (const attempt of attempts) {
    expect(attempt).toThrow(TypeError);
    expect(redactText(`x ${value} y`)).toBe(`x ${REDACTED} y`);
  }
  expect(() => new Unchecked(value)).toThrow(SecretConstructionError);
  expect(live.reveal()).toBe(value);
});

test("keeps the value out of its own properties", () => {
  const secret = Secret.make("Hidden-value-0001", { label: "API key" });

  expect(Object.keys(secret)).toEqual(["label", "cloneGuard"]);
  expect(secret.label).toBe("API key");
  expect(
    inspect(secret, { showHidden: true, customInspect: false }),
  ).not.toContain("Hidden-value-0001");
});

test("reveals the value until it is wiped", () => {
  const secret = Secret.make("Reveal-value-0001");

  expect(secret.reveal()).toBe("Reveal-value-0001");
  expect(secret.wiped).toBe(false);

  secret.wipe();
  secret.wipe();
  expect(secret.wiped).toBe(true);
  expect(() => secret.reveal()).toThrow(SecretWipedError);
  expect(String(secret)).toBe("<redacted>");
});

test("logs and redacts to the placeholder, and masks the revealed value", () => {
  const secret = Secret.make("Logged-value-0001", { label: "Weather key" });
  const line = logLine({
    key: secret,
    nested: { list: [secret] },
    error: new Error("call failed", { cause: secret }),
    copied: `sent ${secret.reveal()}`,
  });

  expect(line).not.toContain("Logged-value-0001");
  expect(JSON.parse(line)).toMatchObject({
    key: "<redacted:Weather key>",
    nested: { list: ["<redacted:Weather key>"] },
    error: { message: "call failed", cause: "<redacted:Weather key>" },
    copied: `sent ${REDACTED}`,
  });
  expect(redact({ value: secret })).toEqual({
    value: "<redacted:Weather key>",
  });
});

test("stops masking the value once every Secret holding it is wiped", () => {
  const first = Secret.make("Shared-value-0001");
  const second = Secret.make("Shared-value-0001");

  first.wipe();
  expect(redactText("x Shared-value-0001 y")).toBe(`x ${REDACTED} y`);

  second.wipe();
  expect(redactText("x Shared-value-0001 y")).toBe("x Shared-value-0001 y");
});

test("holds a value under 8 characters, which only the wrapper hides", () => {
  const secret = Secret.make("pin1234");

  expect(String(secret)).toBe("<redacted>");
  expect(logLine({ value: secret })).not.toContain("pin1234");
  expect(redactText("x pin1234 y")).toBe("x pin1234 y");
});

test("can't be bound as a database parameter", () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-secret-"));
  const db = openStore(join(dir, "aphelion.db"));
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  db.exec("CREATE TABLE probe (value TEXT)");
  const secret = Secret.make("Stored-value-0001");

  expect(() => {
    db.run("INSERT INTO probe VALUES (?)", [secret as unknown as SqlValue]);
  }).toThrow();
  db.run("INSERT INTO probe VALUES (?)", ["ordinary"]);
  expect(db.all("SELECT value FROM probe")).toEqual([{ value: "ordinary" }]);
});
