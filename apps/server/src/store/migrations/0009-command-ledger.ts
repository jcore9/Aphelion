import type { Migration } from "../migrate";

export const commandLedger: Migration = {
  version: 9,
  name: "command-ledger",
  sql: `CREATE TABLE commands (
    device TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running', 'done', 'failed')),
    result TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (device, id),
    CHECK ((state = 'running') = (result IS NULL))
  ) STRICT;
  CREATE INDEX commands_created ON commands (created_at);
  CREATE INDEX events_bot ON events (bot, position);`,
};
