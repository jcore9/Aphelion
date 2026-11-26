import { randomUUIDv7 } from "node:crypto";
import type { Database } from "./database";

const key = "server_id";
const streamKey = "stream_id";

export function ensureServerId(db: Database): string {
  return db.transaction(() => {
    db.run(
      "INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      [key, randomUUIDv7()],
    );
    db.run(
      "INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
      [streamKey, randomUUIDv7()],
    );
    return readServerId(db);
  });
}

function readMeta(db: Database, name: string, what: string): string {
  const value = db.all("SELECT value FROM server_meta WHERE key = ?", [
    name,
  ])[0]?.["value"];
  if (typeof value !== "string") {
    throw new Error(`The database has no ${what}. Open it with openStore.`);
  }
  return value;
}

export function readServerId(db: Database): string {
  return readMeta(db, key, "server ID");
}

export function readStreamId(db: Database): string {
  return readMeta(db, streamKey, "stream ID");
}

export function renewStreamId(db: Database): string {
  return db.transaction(() => {
    const next = randomUUIDv7();
    db.run(
      "INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [streamKey, next],
    );
    return next;
  });
}
