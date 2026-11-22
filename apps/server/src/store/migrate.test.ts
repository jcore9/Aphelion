import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openSqlite } from "../adapters/sqlite";
import type { Database } from "./database";
import { migrate, type Migration } from "./migrate";

const notes: Migration = {
  version: 1,
  name: "notes",
  sql: "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
};
const tags: Migration = {
  version: 2,
  name: "tags",
  sql: `
    CREATE TABLE tags (note_id INTEGER NOT NULL REFERENCES notes (id), tag TEXT NOT NULL);
    CREATE TRIGGER tags_append_only BEFORE UPDATE ON tags
    BEGIN SELECT RAISE(ABORT, 'tags are append-only'); END;
  `,
};
const broken: Migration = {
  version: 2,
  name: "broken",
  sql: "CREATE TABLE half (x INTEGER); CREATE TABLE oops (",
};

function openDatabase(): Database {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-migrate-"));
  const db = openSqlite(join(dir, "aphelion.db"));
  onTestFinished(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  return db;
}

function tables(db: Database): string[] {
  return db
    .all("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => String(row["name"]));
}

function recorded(db: Database): string[] {
  return db
    .all("SELECT name FROM schema_migrations ORDER BY version")
    .map((row) => String(row["name"]));
}

test("applies every migration to a fresh database and records each one", () => {
  const db = openDatabase();

  expect(migrate(db, [notes, tags])).toEqual([notes, tags]);
  expect(tables(db)).toEqual(["notes", "schema_migrations", "tags"]);
  expect(recorded(db)).toEqual(["notes", "tags"]);
});

test("does nothing when run a second time", () => {
  const db = openDatabase();
  migrate(db, [notes, tags]);
  db.run("INSERT INTO notes (body) VALUES (?)", ["hello"]);

  expect(migrate(db, [notes, tags])).toEqual([]);
  expect(db.all("SELECT body FROM notes")).toEqual([{ body: "hello" }]);
  expect(recorded(db)).toEqual(["notes", "tags"]);
});

test("applies only the migrations added since the last run", () => {
  const db = openDatabase();
  migrate(db, [notes]);

  expect(migrate(db, [notes, tags])).toEqual([tags]);
  expect(recorded(db)).toEqual(["notes", "tags"]);
});

test("refuses a database whose schema is newer than the code knows", () => {
  const db = openDatabase();
  migrate(db, [notes, tags]);

  expect(() => migrate(db, [notes])).toThrow(
    "The database schema is at version 2, newer than version 1",
  );
  expect(recorded(db)).toEqual(["notes", "tags"]);
});

test("refuses a database that recorded a different migration under a version", () => {
  const db = openDatabase();
  migrate(db, [notes, tags]);

  expect(() => migrate(db, [notes, { ...tags, name: "labels" }])).toThrow(
    `this server's migration 2 is "labels"`,
  );
});

test("rolls back the whole run when a migration fails partway", () => {
  const db = openDatabase();

  expect(() => migrate(db, [notes, broken])).toThrow(
    'Migration 2 "broken" failed.',
  );
  expect(tables(db)).toEqual([]);

  expect(migrate(db, [notes, tags])).toEqual([notes, tags]);
});

test("keeps earlier runs when a later run fails", () => {
  const db = openDatabase();
  migrate(db, [notes]);

  expect(() => migrate(db, [notes, broken])).toThrow(
    'Migration 2 "broken" failed.',
  );
  expect(tables(db)).toEqual(["notes", "schema_migrations"]);
  expect(recorded(db)).toEqual(["notes"]);
});

test("refuses a migration list whose versions are not 1, 2, 3 in order", () => {
  const db = openDatabase();

  expect(() => migrate(db, [tags])).toThrow(
    'Migration "tags" has version 2, expected 1.',
  );
  expect(() => migrate(db, [notes, { ...tags, version: 3 }])).toThrow(
    'Migration "tags" has version 3, expected 2.',
  );
  expect(tables(db)).toEqual([]);
});
