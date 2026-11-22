import { openSqlite } from "../adapters/sqlite";
import type { Database } from "./database";
import { migrate } from "./migrate";
import { migrations } from "./migrations";

export type { Database, Row, SqlValue } from "./database";
export type { Migration } from "./migrate";

export function openStore(path: string): Database {
  const db = openSqlite(path);
  try {
    migrate(db, migrations);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
