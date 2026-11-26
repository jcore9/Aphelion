import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import {
  addDevice,
  checkAuthorization,
  listDevices,
  revokeAllDevices,
  revokeDevice,
} from "../devices";
import {
  recordVersion,
  switchedOffPlugins,
  type ApprovedVersion,
} from "../plugins/approvals";
import { openStore, type Database } from "../store";
import { finishRestore } from ".";

function openTemp(): Database {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-restore-"));
  const db = openStore(join(dir, "aphelion.db"));
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const plugin = (id: string): ApprovedVersion => ({
  plugin: id,
  version: "1.0.0",
  source: "folder",
  folder: `/opt/aphelion/plugins/${id}`,
  filesDigest: `digest-${id}`,
  repository: undefined,
  grants: [{ kind: "events", name: "bot.status" }],
});

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
const authorized = (db: Database, token: string) =>
  checkAuthorization(db, `Bearer ${token}`).ok;

const restoreAudit = (db: Database) =>
  db
    .all("SELECT actor_kind, outcome, detail FROM audit_log WHERE action = ?", [
      "restore.finish",
    ])
    .map((row) => ({
      actor: row["actor_kind"],
      outcome: row["outcome"],
      detail: JSON.parse(String(row["detail"])) as unknown,
    }));

test("a device token from before the restore is refused after it, and a new device works", () => {
  const db = openTemp();
  const old = addDevice(db, { name: "laptop" });
  expect(authorized(db, old.token)).toBe(true);

  finishRestore(db);

  expect(authorized(db, old.token)).toBe(false);
  const fresh = addDevice(db, { name: "laptop" }, later(5));
  expect(authorized(db, fresh.token)).toBe(true);
  expect(authorized(db, old.token)).toBe(false);
});

test("revokeAllDevices revokes only the active devices and names them", () => {
  const db = openTemp();
  const kept = addDevice(db, { name: "kept" });
  const gone = addDevice(db, { name: "gone" });
  revokeDevice(db, gone.id);
  const expired = addDevice(
    db,
    { name: "expired", lifetimeDays: 1 },
    new Date(Date.now() - 2 * 86_400_000),
  );

  expect(revokeAllDevices(db).sort()).toEqual([expired.id, kept.id].sort());
  expect(revokeAllDevices(db)).toEqual([]);
  expect(listDevices(db).every((device) => device.revokedAt !== null)).toBe(
    true,
  );
});

test("finishing a restore switches every plugin off, lists them and audits the run", () => {
  const db = openTemp();
  const laptop = addDevice(db, { name: "laptop" });
  recordVersion(db, plugin("weather"));
  recordVersion(db, plugin("clock"));

  const result = finishRestore(db);

  expect(result).toEqual({ switchedOff: ["clock", "weather"] });
  expect(switchedOffPlugins(db)).toEqual(["clock", "weather"]);
  expect(restoreAudit(db)).toEqual([
    {
      actor: "cli",
      outcome: "succeeded",
      detail: {
        devices: [laptop.id],
        plugins: ["clock", "weather"],
      },
    },
  ]);
});

test("finishing twice with no device enrolled in between gives the same list and revokes nothing more", () => {
  const db = openTemp();
  addDevice(db, { name: "laptop" });
  recordVersion(db, plugin("weather"));
  const first = finishRestore(db);
  const revokedAt = listDevices(db).map((device) => device.revokedAt);

  const second = finishRestore(db);

  expect(second).toEqual(first);
  expect(listDevices(db).map((device) => device.revokedAt)).toEqual(revokedAt);
  expect(switchedOffPlugins(db)).toEqual(["weather"]);
});

test("restoring a backup taken after an earlier restore revokes the devices enrolled since", () => {
  const db = openTemp();
  addDevice(db, { name: "laptop" });
  recordVersion(db, plugin("weather"));
  finishRestore(db);
  const enrolledLater = addDevice(db, { name: "phone" }, later(5));
  db.run("UPDATE plugin_installs SET enabled = 1");

  expect(finishRestore(db)).toEqual({ switchedOff: ["weather"] });

  expect(authorized(db, enrolledLater.token)).toBe(false);
  expect(restoreAudit(db)).toHaveLength(2);
});

test("a restore with no devices and no plugins still finishes and is audited", () => {
  const db = openTemp();

  expect(finishRestore(db)).toEqual({ switchedOff: [] });
  expect(restoreAudit(db)).toHaveLength(1);
});

test("a failure partway through leaves devices and plugins as they were, so a rerun finishes the job", () => {
  const db = openTemp();
  const laptop = addDevice(db, { name: "laptop" });
  recordVersion(db, plugin("weather"));
  db.exec(`CREATE TRIGGER fail_restore_audit BEFORE INSERT ON audit_log
    WHEN NEW.action = 'restore.finish'
    BEGIN SELECT RAISE(ABORT, 'disk full'); END`);

  expect(() => finishRestore(db)).toThrow("disk full");
  expect(authorized(db, laptop.token)).toBe(true);
  expect(switchedOffPlugins(db)).toEqual([]);

  db.exec("DROP TRIGGER fail_restore_audit");
  expect(finishRestore(db)).toEqual({ switchedOff: ["weather"] });
  expect(authorized(db, laptop.token)).toBe(false);
});
