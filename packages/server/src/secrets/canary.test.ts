import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format, inspect } from "node:util";
import { expect, onTestFinished, test } from "vitest";
import { appendAudit } from "../audit";
import { createLogger } from "../log";
import { openStore } from "../store";
import { Secret, SecretSerializationError } from ".";

function encodedForms(value: string): string[] {
  return [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    encodeURIComponent(value),
  ];
}

function folderBytes(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name)).toString("latin1"))
    .join("\n");
}

test("a canary value never reaches the logs or the database files", () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-canary-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  const db = openStore(join(dir, "aphelion.db"));
  const canary = `Canary/${randomUUID()}+&=`;
  const marker = `visible-${randomUUID()}`;
  const secret = Secret.make(canary, { label: "Canary" });
  const value = secret.reveal();
  const lines: string[] = [];
  const log = createLogger({
    level: "debug",
    write: (line) => lines.push(line),
  });

  const wrapped = {
    marker,
    secret,
    nested: { list: [{ secret }], map: new Map([["k", secret]]) },
    error: new Error("call failed", { cause: secret }),
    chained: new Error("outer", {
      cause: new AggregateError(
        [new Error("inner", { cause: secret })],
        "group",
        {
          cause: { secret },
        },
      ),
    }),
  };
  const revealedCopies = {
    copied: `the value is ${value}`,
    base64: Buffer.from(value, "utf8").toString("base64"),
    uri: encodeURIComponent(value),
    token: value,
    json: JSON.stringify({ note: value }),
    error: new Error(`request failed for ${value}`),
  };
  const everyShape = { ...wrapped, revealedCopies };
  log.debug("debug", everyShape);
  log.info("info", everyShape);
  log.warn("warn", { error: wrapped.error });
  log.error("error", { error: wrapped.chained });
  lines.push(
    String(secret),
    inspect(wrapped, { depth: 10 }),
    format("%s %o %O", secret, secret, wrapped.chained),
  );
  expect(() => JSON.stringify(wrapped)).toThrow(SecretSerializationError);

  for (const outcome of ["succeeded", "failed"] as const) {
    appendAudit(db, {
      actor: { kind: "plugin", id: value },
      action: "secret.resolve",
      outcome,
      sessionId: `session ${value}`,
      requestId: encodeURIComponent(value),
      detail: everyShape,
    });
  }

  const logText = lines.join("\n");
  const whileOpen = folderBytes(dir);
  expect(readdirSync(dir)).toContain("aphelion.db-wal");
  db.close();
  const afterClose = folderBytes(dir);

  const sources = { logText, whileOpen, afterClose };
  for (const [name, text] of Object.entries(sources)) {
    expect(text.includes(marker), `${name} has the marker`).toBe(true);
    for (const form of encodedForms(canary)) {
      expect(text.includes(form), `${name} leaks ${form}`).toBe(false);
    }
  }
});
