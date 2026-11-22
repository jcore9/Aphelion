import type { Migration } from "../migrate";

export const auditLog: Migration = {
  version: 1,
  name: "audit-log",
  sql: `
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY,
      at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      actor_kind TEXT NOT NULL CHECK (actor_kind <> ''),
      actor_id TEXT,
      action TEXT NOT NULL CHECK (action <> ''),
      outcome TEXT NOT NULL CHECK (outcome <> ''),
      agent_id TEXT,
      session_id TEXT,
      request_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}' CHECK (json_type(detail) = 'object')
    ) STRICT;

    CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
    WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,
};
