import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openStore, readServerId } from ".";
import { openSqlite } from "../adapters/sqlite";
import { migrate } from "./migrate";
import { migrations } from "./migrations";

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-server-id-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
}

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a fresh database gets a UUIDv7 server ID, and a reopen keeps it", () => {
  const path = tempDatabasePath();
  const first = openStore(path);
  const id = readServerId(first);
  first.close();

  const second = openStore(path);
  onTestFinished(() => {
    second.close();
  });

  expect(id).toMatch(uuidV7);
  expect(readServerId(second)).toBe(id);
});

test("two fresh databases get different server IDs", () => {
  const one = openStore(tempDatabasePath());
  const other = openStore(tempDatabasePath());
  onTestFinished(() => {
    one.close();
    other.close();
  });

  expect(readServerId(one)).not.toBe(readServerId(other));
});

test("a database that was migrated before the server ID existed gets one on the next open", () => {
  const path = tempDatabasePath();
  const old = openSqlite(path);
  migrate(old, migrations);
  old.close();

  const store = openStore(path);
  onTestFinished(() => {
    store.close();
  });

  expect(readServerId(store)).toMatch(uuidV7);
});

test("reading the server ID of a database that was not opened with openStore says so", () => {
  const old = openSqlite(tempDatabasePath());
  onTestFinished(() => {
    old.close();
  });
  migrate(old, migrations);

  expect(() => readServerId(old)).toThrow("no server ID");
});

test("the position counter starts at 1", () => {
  const store = openStore(tempDatabasePath());
  onTestFinished(() => {
    store.close();
  });

  expect(
    store.all("SELECT value FROM server_meta WHERE key = 'next_position'"),
  ).toEqual([{ value: "1" }]);
});
