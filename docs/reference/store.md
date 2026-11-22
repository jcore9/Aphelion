# The SQLite store

The server keeps its state in one SQLite database, at `/var/lib/aphelion/` in the container ([decision 0014](../decisions/0014-filesystem-layout.md)). [Decision 0026](../decisions/0026-sqlite-driver.md) explains the driver and the migration format.

## Code

| File | Holds |
| --- | --- |
| `packages/server/src/store/database.ts` | The `Database` interface that the rest of the server uses |
| `packages/server/src/store/index.ts` | `openStore(path)`, which opens the database and applies the migrations |
| `packages/server/src/store/migrate.ts` | The `Migration` type and the runner |
| `packages/server/src/store/migrations/` | The migrations, listed in order in `index.ts` |
| `packages/server/src/adapters/sqlite.ts` | The `bun:sqlite` driver, the only file that imports it |

## The `Database` interface

| Method | Does |
| --- | --- |
| `exec(sql)` | Runs a script of one or more statements, with no parameters |
| `run(sql, params)` | Runs one statement with `?` parameters and returns nothing |
| `all(sql, params)` | Runs one statement and returns its rows |
| `transaction(fn)` | Runs `fn` in a `BEGIN IMMEDIATE` transaction. It commits when `fn` returns and rolls back when `fn` throws. |
| `close()` | Closes the connection |

To get an ID or a count back from a write, use `RETURNING` with `all`.

Every connection uses WAL mode, enforces foreign keys and waits up to 5 seconds for a write lock. The adapter creates the database file with mode 0600, and SQLite gives the `-wal` and `-shm` files the same mode.

## Add a migration

1. Create `packages/server/src/store/migrations/NNNN-<name>.ts`, with `NNNN` the next version number:

   ```ts
   import type { Migration } from "../migrate";

   export const devices: Migration = {
   	version: 2,
   	name: "devices",
   	sql: `
   		CREATE TABLE devices (
   			id INTEGER PRIMARY KEY,
   			name TEXT NOT NULL
   		) STRICT;
   	`,
   };
   ```

2. Add it to the end of the list in `packages/server/src/store/migrations/index.ts`.
3. Run `bun run test`. The store test applies every listed migration to a fresh database.
4. Add a test for the tables that the migration creates, next to the code that uses them.

## Migrations

| Version | Name | Creates |
| --- | --- | --- |
| 1 | `audit-log` | The append-only `audit_log` table ([logging and the audit log](logging.md#the-audit-log)) |

## Rules

- Migrations only go forward. To undo a change, write a new migration.
- Never edit, rename or reorder a migration that has merged into `dev`. A server refuses a database whose recorded name doesn't match its own migration with the same version.
- Versions start at 1 and go up by one, in list order. The runner refuses a list with a gap.
- Put no `BEGIN`, `COMMIT`, `ROLLBACK` or `PRAGMA foreign_keys` in a migration. The runner runs every pending migration in one transaction.
- A server refuses a database that has more migrations than it knows. Run a newer server, or restore a backup.
- If a migration fails, the whole run rolls back and the server doesn't start. The database stays at the version it had before.
