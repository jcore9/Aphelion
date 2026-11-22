import type { Migration } from "../migrate";

export const devices: Migration = {
  version: 2,
  name: "devices",
  sql: `
    CREATE TABLE devices (
      id TEXT PRIMARY KEY CHECK (length(id) = 16 AND id NOT GLOB '*[^0-9a-f]*'),
      name TEXT NOT NULL CHECK (name <> ''),
      token_hash BLOB NOT NULL UNIQUE CHECK (length(token_hash) = 32),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK (expires_at > created_at),
      revoked_at TEXT
    ) STRICT;
  `,
};
