import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openSqlite } from "./sqlite";

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-sqlite-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("creates the database and its WAL files with mode 0600", () => {
  const path = databasePath();
  const db = openSqlite(path);
  db.exec("CREATE TABLE t (x INTEGER)");

  expect(mode(path)).toBe(0o600);
  expect(mode(`${path}-wal`)).toBe(0o600);
  expect(mode(`${path}-shm`)).toBe(0o600);
  db.close();
});

test("opens the database in WAL mode", () => {
  const db = openSqlite(databasePath());

  expect(db.all("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
  db.close();
});

test("keeps data across reopening", () => {
  const path = databasePath();
  const first = openSqlite(path);
  first.exec("CREATE TABLE t (x TEXT)");
  first.run("INSERT INTO t (x) VALUES (?)", ["kept"]);
  first.close();

  const second = openSqlite(path);
  expect(second.all("SELECT x FROM t")).toEqual([{ x: "kept" }]);
  second.close();
});

test("commits a transaction that returns and rolls back one that throws", () => {
  const db = openSqlite(databasePath());
  db.exec("CREATE TABLE t (x INTEGER)");

  const result = db.transaction(() => {
    db.run("INSERT INTO t VALUES (1)");
    return "done";
  });
  expect(result).toBe("done");
  expect(() =>
    db.transaction(() => {
      db.run("INSERT INTO t VALUES (2)");
      throw new Error("abort");
    }),
  ).toThrow("abort");

  expect(db.all("SELECT x FROM t")).toEqual([{ x: 1 }]);
  db.close();
});

test("enforces foreign keys", () => {
  const db = openSqlite(databasePath());
  db.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id));
    INSERT INTO parent (id) VALUES (1);
  `);

  db.run("INSERT INTO child (parent_id) VALUES (?)", [1]);
  expect(() => {
    db.run("INSERT INTO child (parent_id) VALUES (?)", [2]);
  }).toThrow(/FOREIGN KEY/);
  db.close();
});
