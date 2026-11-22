import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { maskSecretValue, unmaskSecretValue } from "../log";
import { openStore, type Database } from "../store";
import { appendAudit, type AuditEntry } from ".";

function openDatabase(): Database {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-audit-"));
  const db = openStore(join(dir, "aphelion.db"));
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  return db;
}

const approval = {
  actor: { kind: "device", id: "laptop" },
  action: "approval.decide",
  outcome: "allowed",
  botId: "triage",
  sessionId: "s-1",
  requestId: "r-1",
  detail: { tool: "git push", remote: "origin" },
} satisfies AuditEntry<"approval.decide">;

test("appends an entry and reads it back with every field", () => {
  const db = openDatabase();
  const id = appendAudit(db, approval);

  const [row] = db.all("SELECT * FROM audit_log WHERE id = ?", [id]);
  expect(row).toMatchObject({
    actor_kind: "device",
    actor_id: "laptop",
    action: "approval.decide",
    outcome: "allowed",
    bot_id: "triage",
    session_id: "s-1",
    request_id: "r-1",
  });
  expect(JSON.parse(String(row?.["detail"]))).toEqual({
    tool: "git push",
    remote: "origin",
  });
  expect(String(row?.["at"])).toMatch(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/,
  );
});

test("stores an actor with no id, and leaves unrelated ids empty", () => {
  const db = openDatabase();
  const id = appendAudit(db, {
    actor: { kind: "server" },
    action: "server.start",
    outcome: "succeeded",
  });

  expect(db.all("SELECT * FROM audit_log WHERE id = ?", [id])).toMatchObject([
    {
      actor_id: null,
      bot_id: null,
      session_id: null,
      request_id: null,
      detail: "{}",
    },
  ]);
});

test("gives each entry a larger id than the one before", () => {
  const db = openDatabase();
  const first = appendAudit(db, approval);
  const second = appendAudit(db, { ...approval, outcome: "denied" });

  expect(second).toBeGreaterThan(first);
});

test("redacts secrets in the detail before they reach the database", () => {
  const db = openDatabase();
  appendAudit(db, {
    ...approval,
    detail: {
      command: "curl -H 'Authorization: Bearer abc123def456ghi'",
      token: "plain-audit-token",
      remote: "origin",
    },
  });

  const [row] = db.all("SELECT detail FROM audit_log");
  expect(row?.["detail"]).not.toContain("abc123def456ghi");
  expect(row?.["detail"]).not.toContain("plain-audit-token");
  expect(row?.["detail"]).toContain('"remote":"origin"');
});

test("rejects UPDATE, DELETE and INSERT OR REPLACE, and keeps the row", () => {
  const db = openDatabase();
  const id = appendAudit(db, approval);

  for (const sql of [
    "UPDATE audit_log SET outcome = 'denied'",
    "DELETE FROM audit_log",
    `INSERT OR REPLACE INTO audit_log (id, actor_kind, action, outcome)
      VALUES (${String(id)}, 'server', 'forged', 'denied')`,
    `INSERT INTO audit_log (id, actor_kind, action, outcome)
      VALUES (${String(id)}, 'server', 'forged', 'denied')
      ON CONFLICT (id) DO UPDATE SET action = 'forged'`,
  ]) {
    expect(() => {
      db.run(sql);
    }, sql).toThrow("audit_log is append-only");
  }
  expect(db.all("SELECT id, action, outcome FROM audit_log")).toEqual([
    { id, action: "approval.decide", outcome: "allowed" },
  ]);
});

test("rejects an empty action and a detail that is not a JSON object", () => {
  const db = openDatabase();

  expect(() => appendAudit(db, { ...approval, action: "" })).toThrow();
  expect(() => {
    db.run(
      "INSERT INTO audit_log (actor_kind, action, outcome, detail) VALUES ('server', 'x', 'failed', '[1]')",
    );
  }).toThrow();
  expect(db.all("SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 0 }]);
});

test("redacts secrets in every text column, and keeps ordinary ids", () => {
  const db = openDatabase();
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  appendAudit(db, {
    actor: { kind: "bot", id: token },
    action: `secret.read ${token}`,
    outcome: "denied",
    botId: token,
    sessionId: token,
    requestId: `Bearer abc123def456ghi`,
  });
  appendAudit(db, approval);

  const rows = db.all("SELECT * FROM audit_log ORDER BY id");
  expect(JSON.stringify(rows)).not.toContain(
    "abcdefghijklmnopqrstuvwxyz0123456789",
  );
  expect(JSON.stringify(rows)).not.toContain("abc123def456ghi");
  expect(rows[0]).toMatchObject({
    actor_id: "[REDACTED]",
    action: "secret.read [REDACTED]",
    bot_id: "[REDACTED]",
    request_id: "Bearer [REDACTED]",
  });
  expect(rows[1]).toMatchObject({
    actor_id: "laptop",
    bot_id: "triage",
    session_id: "s-1",
    request_id: "r-1",
  });
});

test("rejects an explicit id of -1 or 0, and later appends still work", () => {
  const db = openDatabase();

  for (const id of [-1, 0]) {
    expect(() => {
      db.run(
        `INSERT INTO audit_log (id, actor_kind, action, outcome) VALUES (${String(id)}, 'server', 'x', 'failed')`,
      );
    }).toThrow();
  }
  const first = appendAudit(db, approval);
  const second = appendAudit(db, approval);

  expect(second).toBeGreaterThan(first);
  expect(db.all("SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 2 }]);
});

test("stores a marker object when the detail can't be read, and keeps the row", () => {
  const db = openDatabase();
  const unreadable = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("plain-detail-error");
      },
    },
  );
  const id = appendAudit(db, { ...approval, detail: unreadable });
  const other = appendAudit(db, {
    ...approval,
    detail: { toJSON: () => "not an object" },
  });

  expect(
    db.all("SELECT id, detail FROM audit_log WHERE id IN (?, ?) ORDER BY id", [
      id,
      other,
    ]),
  ).toEqual([
    { id, detail: '{"unreadable":true}' },
    { id: other, detail: '{"unreadable":true}' },
  ]);
});

test("masks a secret JSON field next to a URL in the action", () => {
  const db = openDatabase();
  appendAudit(db, {
    ...approval,
    action:
      '{"url":"https://example.test/?token=fake","password": "CANARYaudit1"}',
  });

  const [row] = db.all("SELECT action FROM audit_log");
  expect(row?.["action"]).not.toContain("CANARYaudit1");
  expect(row?.["action"]).toContain(
    '"url":"https://example.test/?token=[REDACTED]"',
  );
});

test("stores a marker object when reading the detail itself throws", () => {
  const db = openDatabase();
  const entry = Object.defineProperty({ ...approval }, "detail", {
    get() {
      throw new Error("plain-detail-getter");
    },
  });
  const id = appendAudit(db, entry);

  expect(db.all("SELECT detail FROM audit_log WHERE id = ?", [id])).toEqual([
    { detail: '{"unreadable":true}' },
  ]);
});

test("accepts only fixed text as the action, at compile time", () => {
  const db = openDatabase();
  const tool = String(db.all("SELECT 1 AS n").length);

  appendAudit(db, { ...approval, action: "secret.read" });
  // @ts-expect-error An action held in a variable isn't fixed text.
  appendAudit(db, { ...approval, action: tool });
  // @ts-expect-error A template with a value in it isn't fixed text.
  appendAudit(db, { ...approval, action: `tool.${tool}` });

  expect(db.all("SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 3 }]);
});

test("masks a registered secret value in every free-text column, key and number", () => {
  const db = openDatabase();
  maskSecretValue("Audit7rQ-live-value");
  maskSecretValue("86753090");
  appendAudit(db, {
    actor: { kind: "bot", id: "Audit7rQ-live-value" },
    action: "secret.read Audit7rQ-live-value",
    outcome: "succeeded",
    botId: "a Audit7rQ-live-value",
    sessionId: "s Audit7rQ-live-value",
    requestId: "r Audit7rQ-live-value",
    detail: { "Audit7rQ-live-value": 1, pin: 86753090, tool: "git push" },
  });

  const [row] = db.all("SELECT * FROM audit_log");
  expect(JSON.stringify(row)).not.toContain("Audit7rQ-live-value");
  expect(JSON.stringify(row)).not.toContain("86753090");
  expect(row).toMatchObject({
    actor_kind: "bot",
    actor_id: "[REDACTED]",
    action: "secret.read [REDACTED]",
    outcome: "succeeded",
    bot_id: "a [REDACTED]",
    session_id: "s [REDACTED]",
    request_id: "r [REDACTED]",
  });
  expect(JSON.parse(String(row?.["detail"]))).toEqual({
    "[REDACTED]": 1,
    pin: "[REDACTED]",
    tool: "git push",
  });
});

test("keeps the outcome and actor kind even when they are registered as masks", () => {
  const db = openDatabase();
  maskSecretValue("succeeded");
  try {
    appendAudit(db, { ...approval, outcome: "succeeded" });
  } finally {
    unmaskSecretValue("succeeded");
  }

  expect(db.all("SELECT actor_kind, outcome FROM audit_log")).toEqual([
    { actor_kind: "device", outcome: "succeeded" },
  ]);
});

test("rejects an outcome or actor kind outside its list, and writes no row", () => {
  const db = openDatabase();

  expect(() =>
    appendAudit(db, { ...approval, outcome: "maybe" as "allowed" }),
  ).toThrow(TypeError);
  expect(() =>
    appendAudit(db, {
      ...approval,
      actor: { kind: "admin" as "server" },
    }),
  ).toThrow(TypeError);
  expect(db.all("SELECT count(*) AS n FROM audit_log")).toEqual([{ n: 0 }]);
});
