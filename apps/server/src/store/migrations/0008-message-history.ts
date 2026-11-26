import type { Migration } from "../migrate";

export const messageHistory: Migration = {
  version: 8,
  name: "message-history",
  sql: `CREATE TABLE server_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  INSERT INTO server_meta (key, value) VALUES ('next_position', '1');
  CREATE TABLE turns (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
    server_id TEXT NOT NULL CHECK (length(server_id) = 36),
    bot TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    UNIQUE (id, bot)
  ) STRICT;
  CREATE INDEX turns_open ON turns (bot) WHERE ended_at IS NULL;
  CREATE TABLE events (
    id TEXT PRIMARY KEY CHECK (length(id) = 36),
    server_id TEXT NOT NULL CHECK (length(server_id) = 36),
    position INTEGER NOT NULL UNIQUE CHECK (position >= 1),
    bot TEXT NOT NULL,
    turn TEXT,
    format INTEGER NOT NULL CHECK (format >= 1),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    at INTEGER NOT NULL,
    FOREIGN KEY (turn, bot) REFERENCES turns (id, bot)
  ) STRICT;
  CREATE INDEX events_turn ON events (turn, position) WHERE turn IS NOT NULL;
  CREATE TABLE bot_sessions (
    server_id TEXT NOT NULL CHECK (length(server_id) = 36),
    bot TEXT NOT NULL,
    folder TEXT NOT NULL,
    provider TEXT NOT NULL,
    ref TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, bot)
  ) STRICT;`,
};
