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

function fileBytes(path: string): string {
  return readFileSync(path).toString("latin1");
}

function folderBytes(dir: string): string {
  return readdirSync(dir)
    .map((name) => fileBytes(join(dir, name)))
    .join("\n");
}

test("a canary value never reaches the logs or the database files", () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-canary-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "aphelion.db");
  const db = openStore(path);
  const canary = `Canary/${randomUUID()}+&=`;
  const marker = (name: string) => `${name}-${randomUUID()}`;
  const lineMarkers = [
    "debug",
    "info",
    "warn",
    "error",
    "string",
    "inspect",
    "format",
  ].map(marker);
  const rowMarkers = ["succeeded", "failed"].map(marker);
  const secret = Secret.make(canary, { label: "Canary" });
  const value = secret.reveal();
  const lines: string[] = [];
  const log = createLogger({
    level: "debug",
    write: (line) => lines.push(line),
  });

  const wrapped = {
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
  const [debug, info, warn, error, string, inspected, formatted] = lineMarkers;
  log.debug("debug", { marker: debug, ...everyShape });
  log.info("info", { marker: info, ...everyShape });
  log.warn("warn", { marker: warn, error: wrapped.error });
  log.error("error", { marker: error, error: wrapped.chained });
  lines.push(
    `${string ?? ""} ${String(secret)}`,
    inspect({ marker: inspected, ...wrapped }, { depth: 10 }),
    format("%s %s %o %O", formatted, secret, secret, wrapped.chained),
  );
  expect(() => JSON.stringify(wrapped)).toThrow(SecretSerializationError);

  const outcomes = ["succeeded", "failed"] as const;
  outcomes.forEach((outcome, row) => {
    appendAudit(db, {
      actor: { kind: "plugin", id: value },
      action: "secret.resolve",
      outcome,
      sessionId: `session ${value}`,
      requestId: encodeURIComponent(value),
      detail: { marker: rowMarkers[row], ...everyShape },
    });
  });

  const wal = fileBytes(`${path}-wal`);
  const whileOpen = folderBytes(dir);
  db.close();
  const afterClose = folderBytes(dir);

  expect(lines).toHaveLength(lineMarkers.length);
  lines.forEach((line, i) => {
    expect(line.includes(lineMarkers[i] ?? "?"), `line ${String(i)}`).toBe(
      true,
    );
  });
  for (const rowMarker of rowMarkers) {
    expect(wal.includes(rowMarker), "the WAL holds each row").toBe(true);
  }
  const sources = { logs: lines.join("\n"), wal, whileOpen, afterClose };
  for (const [name, text] of Object.entries(sources)) {
    for (const form of encodedForms(canary)) {
      expect(text.includes(form), `${name} leaks ${form}`).toBe(false);
    }
  }

  const reopened = openStore(path);
  const rows = reopened.all(
    "SELECT outcome, detail FROM audit_log ORDER BY id",
  );
  reopened.close();
  expect(
    rows.map((row) => [
      row["outcome"],
      (JSON.parse(String(row["detail"])) as { marker?: string }).marker,
    ]),
  ).toEqual(outcomes.map((outcome, row) => [outcome, rowMarkers[row]]));
});
