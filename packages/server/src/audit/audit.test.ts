import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
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

const approval: AuditEntry = {
  actor: { kind: "device", id: "laptop" },
  action: "approval.decide",
  outcome: "allowed",
  agentId: "triage",
  sessionId: "s-1",
  requestId: "r-1",
  detail: { tool: "git push", remote: "origin" },
};

test("appends an entry and reads it back with every field", () => {
  const db = openDatabase();
  const id = appendAudit(db, approval);

  const [row] = db.all("SELECT * FROM audit_log WHERE id = ?", [id]);
  expect(row).toMatchObject({
    actor_kind: "device",
    actor_id: "laptop",
    action: "approval.decide",
    outcome: "allowed",
    agent_id: "triage",
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
      agent_id: null,
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
