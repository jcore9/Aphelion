import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, onTestFinished, test, vi } from "vitest";
import { createLogger } from "../log";
import { openStore, type Database } from "../store";
import {
  addDevice,
  checkAuthorization,
  deviceId,
  failureAuditor,
  isDeviceActive,
  revokeDevice,
} from ".";

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, timingSafeEqual: vi.fn(original.timingSafeEqual) };
});

const day = 24 * 60 * 60 * 1000;

function openTemp(): { db: Database; dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-devices-"));
  const path = join(dir, "aphelion.db");
  const db = openStore(path);
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir, path };
}

function auditRows(db: Database) {
  return db
    .all(
      "SELECT actor_kind, action, outcome, detail FROM audit_log ORDER BY id",
    )
    .map((row) => ({
      ...row,
      detail: JSON.parse(String(row["detail"])) as unknown,
    }));
}

const bearer = (token: string) => `Bearer ${token}`;

test("a new token has the fixed prefix, and only its SHA-256 hash is stored", () => {
  const { db } = openTemp();
  const now = new Date("2026-11-22T10:00:00.000Z");

  const added = addDevice(db, { name: "laptop" }, now);

  expect(added.token).toMatch(/^aph_dev_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  expect(added.token.slice(8, 24)).toBe(added.id);
  expect(added).toMatchObject({
    name: "laptop",
    createdAt: "2026-11-22T10:00:00.000Z",
    expiresAt: "2027-02-20T10:00:00.000Z",
  });
  const [row] = db.all("SELECT * FROM devices");
  expect(row).toEqual({
    id: added.id,
    name: "laptop",
    token_hash: new Uint8Array(
      createHash("sha256").update(added.token).digest(),
    ),
    created_at: added.createdAt,
    expires_at: added.expiresAt,
    revoked_at: null,
  });
  expect(addDevice(db, { name: "laptop" }).token).not.toBe(added.token);
});

test("a device name is 1 to 64 characters with no control characters", () => {
  const { db } = openTemp();

  for (const name of ["a", "Jo's phone", "x".repeat(64), "テスト端末"]) {
    expect(addDevice(db, { name }).name).toBe(name);
  }
  for (const name of [
    "",
    " phone",
    "phone ",
    "x".repeat(65),
    "a\nb",
    "a\u0000b",
  ]) {
    expect(() => addDevice(db, { name }), JSON.stringify(name)).toThrow();
  }
  expect(() => addDevice(db, { name: "a", lifetimeDays: 0 })).toThrow();
  expect(() => addDevice(db, { name: "a", lifetimeDays: 366 })).toThrow();
  expect(db.all("SELECT name FROM devices")).toHaveLength(4);
});

test("checkAuthorization accepts a valid token and names each refusal", () => {
  const { db } = openTemp();
  const valid = addDevice(db, { name: "laptop" });
  const revoked = addDevice(db, { name: "old" });
  revokeDevice(db, revoked.id);
  const expired = addDevice(
    db,
    { name: "tablet", lifetimeDays: 1 },
    new Date(Date.now() - 2 * day),
  );
  const wrong = `${valid.token.slice(0, -1)}${valid.token.endsWith("A") ? "B" : "A"}`;
  const unknown = `aph_dev_0123456789abcdef${valid.token.slice(-44)}`;

  expect(checkAuthorization(db, bearer(valid.token))).toEqual({
    ok: true,
    device: { id: valid.id },
  });
  expect(checkAuthorization(db, `bearer ${valid.token}`).ok).toBe(true);
  expect(checkAuthorization(db, undefined)).toEqual({
    ok: false,
    reason: "missing",
  });
  for (const header of [
    "",
    valid.token,
    `Basic ${valid.token}`,
    `Bearer  ${valid.token}`,
    bearer(`${valid.token}x`),
    bearer("aph_dev_short"),
  ]) {
    expect(checkAuthorization(db, header), header).toEqual({
      ok: false,
      reason: "malformed",
    });
  }
  expect(checkAuthorization(db, bearer(wrong))).toEqual({
    ok: false,
    reason: "wrong",
    claimed: valid.id,
  });
  expect(checkAuthorization(db, bearer(unknown))).toEqual({
    ok: false,
    reason: "unknown",
    claimed: "0123456789abcdef",
  });
  expect(checkAuthorization(db, bearer(revoked.token))).toEqual({
    ok: false,
    reason: "revoked",
    claimed: revoked.id,
  });
  expect(checkAuthorization(db, bearer(expired.token))).toEqual({
    ok: false,
    reason: "expired",
    claimed: expired.id,
  });
});

test("every presented token is compared in constant time, known device or not", () => {
  const { db } = openTemp();
  const valid = addDevice(db, { name: "laptop" });
  const compare = vi.mocked(timingSafeEqual);
  const headers = [
    bearer(valid.token),
    bearer(
      `${valid.token.slice(0, -1)}${valid.token.endsWith("A") ? "B" : "A"}`,
    ),
    bearer(`aph_dev_0123456789abcdef${valid.token.slice(-44)}`),
    bearer("not-a-device-token"),
  ];

  for (const header of headers) {
    compare.mockClear();
    checkAuthorization(db, header);
    expect(compare, header).toHaveBeenCalledOnce();
  }
});

test("a token expires at its expiry time", () => {
  const { db } = openTemp();
  const created = new Date("2026-11-22T10:00:00.000Z");
  const device = addDevice(db, { name: "laptop", lifetimeDays: 1 }, created);
  const justBefore = new Date(created.getTime() + day - 1);
  const atExpiry = new Date(created.getTime() + day);

  expect(isDeviceActive(db, device.id, justBefore)).toBe(true);
  expect(checkAuthorization(db, bearer(device.token), justBefore).ok).toBe(
    true,
  );
  expect(isDeviceActive(db, device.id, atExpiry)).toBe(false);
  expect(checkAuthorization(db, bearer(device.token), atExpiry)).toMatchObject({
    reason: "expired",
  });
});

test("revoking writes revoked_at once and audits every call", () => {
  const { db } = openTemp();
  const device = addDevice(db, { name: "laptop" });

  expect(isDeviceActive(db, device.id)).toBe(true);
  expect(revokeDevice(db, device.id)).toBe(true);
  expect(isDeviceActive(db, device.id)).toBe(false);
  expect(revokeDevice(db, device.id)).toBe(false);
  expect(revokeDevice(db, "0123456789abcdef")).toBe(false);
  expect(revokeDevice(db, device.token)).toBe(false);

  expect(auditRows(db)).toEqual([
    {
      actor_kind: "cli",
      action: "device.add",
      outcome: "succeeded",
      detail: {
        device: device.id,
        name: "laptop",
        expiresAt: device.expiresAt,
      },
    },
    {
      actor_kind: "cli",
      action: "device.revoke",
      outcome: "succeeded",
      detail: { device: device.id },
    },
    {
      actor_kind: "cli",
      action: "device.revoke",
      outcome: "failed",
      detail: { device: device.id },
    },
    {
      actor_kind: "cli",
      action: "device.revoke",
      outcome: "failed",
      detail: { device: "0123456789abcdef" },
    },
    {
      actor_kind: "cli",
      action: "device.revoke",
      outcome: "failed",
      detail: {},
    },
  ]);
});

test("failed attempts are audited, at most a fixed number of rows per window", () => {
  const { db } = openTemp();
  const audit = failureAuditor(db, { rows: 2, windowMs: 1000 });
  const at = (ms: number) => new Date(Date.UTC(2026, 10, 22) + ms);

  audit({ ok: false, reason: "missing" }, at(0));
  audit({ ok: false, reason: "malformed" }, at(0));
  audit(
    { ok: false, reason: "wrong", claimed: deviceId.parse("0123456789abcdef") },
    at(10),
  );
  for (let i = 0; i < 50; i += 1)
    audit({ ok: false, reason: "malformed" }, at(20 + i));
  audit({ ok: false, reason: "revoked" }, at(999));
  audit({ ok: false, reason: "expired" }, at(1000));

  expect(auditRows(db)).toEqual([
    {
      actor_kind: "server",
      action: "device.authenticate",
      outcome: "denied",
      detail: { reason: "malformed" },
    },
    {
      actor_kind: "server",
      action: "device.authenticate",
      outcome: "denied",
      detail: { reason: "wrong", claimedDevice: "0123456789abcdef" },
    },
    {
      actor_kind: "server",
      action: "device.authenticate",
      outcome: "denied",
      detail: { reason: "expired", suppressedBefore: 51 },
    },
  ]);
});

function encodedForms(value: string): string[] {
  return [
    value,
    Buffer.from(value, "utf8").toString("base64"),
    encodeURIComponent(value),
    value.slice(25),
  ];
}

function folderBytes(dir: string): string {
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name)).toString("latin1"))
    .join("\n");
}

test("a device token never reaches the logs or the database files", () => {
  const { db, dir, path } = openTemp();
  const lines: string[] = [];
  const log = createLogger({
    level: "debug",
    write: (line) => lines.push(line),
  });

  const added = addDevice(db, { name: "laptop" });
  const { token } = added;
  revokeDevice(db, added.id);
  const audit = failureAuditor(db);
  for (const header of [
    bearer(token),
    token,
    `Basic ${token}`,
    bearer(`${token}x`),
  ]) {
    const verdict = checkAuthorization(db, header);
    if (!verdict.ok) audit(verdict, new Date());
    log.warn("refused a device token", { verdict, header });
  }
  revokeDevice(db, token);
  log.info("added a device", { added });
  log.info("added a device", { device: added.id, note: `token is ${token}` });
  log.error("failed", {
    error: new Error(`could not use ${token}`),
    raw: inspect(added),
  });

  const whileOpen = folderBytes(dir);
  db.close();
  const afterClose = folderBytes(dir);
  const reopened = openStore(path);
  const rows = JSON.stringify(reopened.all("SELECT * FROM audit_log"));
  reopened.close();

  expect(lines.join("\n")).toContain(added.id);
  expect(rows).toContain(added.id);
  const sources = { logs: lines.join("\n"), whileOpen, afterClose, rows };
  for (const [name, text] of Object.entries(sources)) {
    for (const form of encodedForms(token)) {
      expect(text.includes(form), `${name} leaks ${form}`).toBe(false);
    }
  }
});
