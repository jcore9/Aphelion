import { Database as BunDatabase } from "bun:sqlite";
import { closeSync, openSync } from "node:fs";
import type { Database, Row, SqlValue } from "../store/database";

export class SqlitePathError extends Error {
  override name = "SqlitePathError";

  constructor(readonly path: string) {
    super(
      `SQLite path ${JSON.stringify(path)} is a special name or has surrounding spaces. Pass the path of a database file.`,
    );
  }
}

function isSpecialName(path: string): boolean {
  return (
    path.trim() === "" ||
    path !== path.trim() ||
    path === ":memory:" ||
    path.startsWith("file:")
  );
}

export function openSqlite(path: string): Database {
  if (isSpecialName(path)) throw new SqlitePathError(path);
  closeSync(openSync(path, "a", 0o600));
  const db = new BunDatabase(path, { strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  const journal = db
    .query<{ journal_mode: string }, []>("PRAGMA journal_mode = WAL")
    .get();
  if (journal?.journal_mode !== "wal") {
    db.close();
    throw new Error(`SQLite could not switch ${path} to WAL mode.`);
  }
  db.run("PRAGMA foreign_keys = ON");

  return {
    exec: (sql) => {
      db.run(sql);
    },
    run: (sql, params = []) => {
      db.query<Row, SqlValue[]>(sql).run(...params);
    },
    all: (sql, params = []) => db.query<Row, SqlValue[]>(sql).all(...params),
    transaction: (fn) => db.transaction(fn).immediate(),
    close: () => {
      db.close();
    },
  };
}
