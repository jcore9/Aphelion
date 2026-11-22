import type { Database } from "./database";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export function migrate(
  db: Database,
  migrations: readonly Migration[],
): readonly Migration[] {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Migration "${migration.name}" has version ${String(migration.version)}, expected ${String(index + 1)}.`,
      );
    }
  });

  return db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT`);

    const recorded = db.all(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    if (recorded.length > migrations.length) {
      throw new Error(
        `The database schema is at version ${String(recorded.length)}, newer than version ${String(migrations.length)} that this server knows. Run a newer server.`,
      );
    }
    migrations.slice(0, recorded.length).forEach((known, index) => {
      const row = recorded[index];
      if (row?.["version"] !== known.version || row["name"] !== known.name) {
        throw new Error(
          `The database records migration ${JSON.stringify(row)}, but this server's migration ${String(known.version)} is "${known.name}".`,
        );
      }
    });

    const pending = migrations.slice(recorded.length);
    for (const migration of pending) {
      try {
        db.exec(migration.sql);
      } catch (cause) {
        throw new Error(
          `Migration ${String(migration.version)} "${migration.name}" failed.`,
          { cause },
        );
      }
      db.run("INSERT INTO schema_migrations (version, name) VALUES (?, ?)", [
        migration.version,
        migration.name,
      ]);
    }
    return pending;
  });
}
