import { randomUUIDv7 } from "node:crypto";
import type { Database } from "./database";

const key = "server_id";

export function ensureServerId(db: Database): string {
  return db.transaction(() => {
    db.run(
      "INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      [key, randomUUIDv7()],
    );
    return readServerId(db);
  });
}

export function readServerId(db: Database): string {
  const value = db.all("SELECT value FROM server_meta WHERE key = ?", [
    key,
  ])[0]?.["value"];
  if (typeof value !== "string") {
    throw new Error("The database has no server ID. Open it with openStore.");
  }
  return value;
}
