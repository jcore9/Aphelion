# The SQLite store

The server keeps its state in one SQLite database, at `/var/lib/aphelion/` in the container ([decision 0014](../decisions/0014-filesystem-layout.md)). [Decision 0026](../decisions/0026-sqlite-driver.md) explains the driver and the migration format.

## Code

| File | Holds |
| --- | --- |
| `apps/server/src/store/database.ts` | The `Database` interface that the rest of the server uses |
| `apps/server/src/store/index.ts` | `openStore(path)`, which opens the database and applies the migrations |
| `apps/server/src/store/migrate.ts` | The `Migration` type and the runner |
| `apps/server/src/store/migrations/` | The migrations, listed in order in `index.ts` |
| `apps/server/src/adapters/sqlite.ts` | The `bun:sqlite` driver, the only file that imports it |

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

`openSqlite` takes the path of a database file and nothing else. It throws `SqlitePathError`, before it creates anything on disk, for:

- The empty string, or a name made only of spaces. SQLite opens these as a temporary database.
- A name with spaces at the start or end. Bun trims them, so `" :memory: "` would become `:memory:`.
- `:memory:`, SQLite's name for a database held in memory.
- Any name that starts with `file:`.

Bun opens a `file:` name as an ordinary file today, so the last rule is a precaution. SQLite can also read such a name as a URI, a web-address-style name that carries options such as "keep this in memory". Refusing the prefix means that reading can never apply. A file whose name starts with `file:` still opens when you write it as `./file:aphelion.db` or as a full path. The server always stores its data in a file, and an in-memory database can't use WAL mode.

## Add a migration

1. Create `apps/server/src/store/migrations/NNNN-<name>.ts`, with `NNNN` the next version number:

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

2. Add it to the end of the list in `apps/server/src/store/migrations/index.ts`.
3. Run `bun run test`. The store test applies every listed migration to a fresh database.
4. Add a test for the tables that the migration creates, next to the code that uses them.

## Migrations

| Version | Name | Creates |
| --- | --- | --- |
| 1 | `audit-log` | The append-only `audit_log` table ([logging and the audit log](logging.md#the-audit-log)) |
| 2 | `devices` | The `devices` table of device tokens ([device tokens](devices.md#how-the-server-stores-a-token)) |
| 3 | `audit-bot-id` | Renames `audit_log.agent_id` to `bot_id` ([decision 0039](../decisions/0039-bots-not-agents.md)) |
| 4 | `plugin-grants` | The `plugin_grants` table of approved plugin permissions ([permissions](plugins.md#permissions)) |
| 5 | `plugin-installs` | The `plugin_installs` table: one row per approved plugin, with its folder and manifest digest. The server starts each one at boot. The migration adds a row for each plugin that already had grants. A plugin approved earlier with no permissions needs `aphelion plugin install` again. |
| 6 | `plugin-versions` | Replaces the plugin tables. `plugin_versions` has one row per approved version of a plugin, with its source (`folder` or `release`), folder, files digest and repository. `plugin_installs` names each plugin's current version and the one before it. `plugin_grants` holds the grants of each version. The migration drops the earlier approvals, so every installed plugin needs `aphelion plugin install` again ([permissions](plugins.md#permissions)). |

| 7 | `plugin-enabled` | Adds `plugin_installs.enabled`, `1` by default. A plugin with `0` has no approval and no grants, and [`restore finish`](cli.md#aphelion-restore-finish) sets it for every plugin ([the on and off switch](plugins.md#the-on-and-off-switch)). Every installed plugin stays on when the migration runs. |

## Rules

- Migrations only go forward. To undo a change, write a new migration.
- Never edit, rename or reorder a migration that has merged into `main`. A server refuses a database whose recorded name doesn't match its own migration with the same version.
- Versions start at 1 and go up by one, in list order. The runner refuses a list with a gap.
- Put no `BEGIN`, `COMMIT`, `ROLLBACK` or `PRAGMA foreign_keys` in a migration. The runner runs every pending migration in one transaction.
- A server refuses a database that has more migrations than it knows. Run a newer server, or restore a backup.
- If a migration fails, the whole run rolls back and the server doesn't start. The database stays at the version it had before.
