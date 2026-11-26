# The SQLite store

The server keeps its state in one SQLite database, at `/var/lib/aphelion/` in the container ([decision 0014](../decisions/0014-filesystem-layout.md)). [Decision 0026](../decisions/0026-sqlite-driver.md) explains the driver and the migration format.

## Code

| File | Holds |
| --- | --- |
| `apps/server/src/store/database.ts` | The `Database` interface that the rest of the server uses |
| `apps/server/src/store/index.ts` | `openStore(path)`, which opens the database and applies the migrations |
| `apps/server/src/store/migrate.ts` | The `Migration` type and the runner |
| `apps/server/src/store/migrations/` | The migrations, listed in order in `index.ts` |
| `apps/server/src/store/server-id.ts` | `ensureServerId` and `readServerId` |
| `apps/server/src/history/` | The saved turns and events: the batched writer, the replay to a reconnecting client, and the repair of turns left open |
| `apps/server/src/bots/sqlite-session-refs.ts` | Keeps each bot's session id in `bot_sessions` |
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
| 8 | `message-history` | The `server_meta`, `turns`, `events` and `bot_sessions` tables ([the server ID, turns and events](#the-server-id-turns-and-events)). `server_meta` starts with `next_position` at 1 and `boot_epoch` at 0. `openStore` adds the `server_id` row. |

## The server ID, turns and events

Migration 8 adds four tables, all `STRICT`. Every row in `turns`, `events` and `bot_sessions` carries the `server_id` of the server that wrote it.

| Table | Holds |
| --- | --- |
| `server_meta` | Four rows. `server_id` is a UUIDv7 that never changes. `stream_id` is a UUIDv7 that names the event stream and changes at each restore. `next_position` is the position the next saved event gets. `boot_epoch` is a counter that goes up by one each time the server starts. |
| `turns` | One row per turn: its id, the bot, `started_at`, and `ended_at` with `end_reason`. A turn with no `ended_at` is still open. The server makes the id (a UUIDv7) and inserts the row, owned by the bot, when it starts the turn. It then sends the id to the adapter as the turn's id, so no two bots share one. A turn is never deleted. When the bot refuses a turn, or the server can't hand it to the bot, the server ends the turn with `end_reason` `refused`, whether or not the caller is still waiting. Events saved for that turn stay. Boot repair skips an ended turn. |
| `events` | One row per bot event: `id`, `position`, `bot`, `turn`, `run`, `epoch`, `format`, `kind`, `payload` and `at`. `run` is the number of the bot process run that sent the event, and `epoch` is the `boot_epoch` of the server start that saved it. A `run` starts again at 1 after each server start, so `epoch` and `run` together name one adapter process. An event's `turn` must belong to the event's `bot`, and the database refuses it otherwise. |
| `bot_sessions` | One row per server and bot, with the AI tool's session id, the bot's folder and the bot's provider. The server hands the id to the adapter as `resume` on the next start, and only when the bot, the folder and the provider all match the saved row. A bot that changes provider starts a new session. |

`openStore` creates the server ID right after it applies the migrations. It reads `server_id` and, when there is none, writes a new UUIDv7 in the same transaction. The ID never changes afterwards. A restored backup keeps it, because it is in the database. Two new databases get different IDs.

The same step writes the stream ID, a second UUIDv7, when there is none. The stream ID is the id in a client's cursor (see [event stream](protocol.md#sequence-numbers-and-replay)). It stays the same across restarts, so a cursor still works after one. `aphelion restore finish` writes a new stream ID in its transaction, so a cursor saved before the restore gets `resync`, even though the restored database brings back older positions.

A record's `id` is a UUIDv7 from `node:crypto`. The first 48 bits are the time in milliseconds, so ids sort in creation order. Two servers can't make the same id. `position` is a different thing. It is a counter for this server's stream, and it is the `seq` of the event frame. The server raises `next_position` in the same transaction that inserts the event, so positions have no gap and a position is never used twice, even when the table is emptied. The audit log keeps its integer ids.

`events.kind` is the event's `type`, and `payload` is the rest of the event as JSON text. `format` says how that JSON is shaped. Every event saved today has `format` 1. The server reads format 1 with its own copy of the schema, which a later change to the adapter SDK doesn't touch. A later change to an event's shape raises the number and adds a conversion, and the server keeps reading the rows with older numbers. A row whose `format` the server doesn't know, or whose payload doesn't match its format, makes the replay fail, and the server closes that client's connection.

`text.delta` events hold the conversation. The server saves them as they are, and it never writes them to a log line. The state volume is in every backup, so every backup holds the conversations too. Keep the archive as private as the server.

### How events are written

The writer collects events for up to 50 milliseconds or 200 events, whichever comes first, and inserts them in one transaction. A client gets an event only after that transaction commits, so a client never sees an event that a crash would lose.

The writer saves an event only for a turn that already has a row and belongs to the event's bot. An event that names a turn the server never started is refused, and the server logs `bot events for a turn the server didn't start were not saved` with a count. An event for another bot's turn is refused the same way, with `bot events for another bot's turn were not saved`. Neither log line holds the turn id or any event text. An event for a turn that already ended, such as a late `tool.end`, is still saved.

An orderly shutdown saves every waiting event. The server stops the bots first, so the events a stopping bot sends are still saved. It then takes the events still queued for saving, writes them, and only then closes the database. If that last write fails, the server logs `bot events were not saved at shutdown` with a count, and those events are lost.

The 50 milliseconds is the normal batching window. The guarantee after a crash or a power loss covers the events the database committed. The events that were still waiting are lost, which is normally the last 50 milliseconds. Those events were never sent to a client, so no client has a position that the database lacks. When a write fails, the server logs `saving bot events failed, so the server will retry` and tries again every second. The events wait in memory until the write works, so a crash during that time loses all of them, not only the last 50 milliseconds. The server saves a turn's row when it starts the turn, so a turn whose events were all lost is still closed at the next boot ([below](#turns-that-a-shutdown-left-open)).

The database stays in WAL mode with `synchronous` at its default of `FULL`, because the same database holds device tokens and the audit log, and a revoked token must stay revoked after a power loss. A bot that sends fewer than 4,000 events a second makes at most 20 commits a second, so the cost of the disk flush is small. On the development machine (a Proxmox VM, 4 cores, real disk), saving 5,000 text deltas of 100 bytes took a median of 64 ms in batches and 3,780 ms with one transaction per event. At about 430 events a second, a batched event reached a subscriber after a median of 29 ms and at most 56 ms.

### Turns that a shutdown left open

When the server stops while a bot is in the middle of a turn, that turn has no `turn.end`. At boot, before the server listens, it closes each open turn the way [the bot runner closes a turn when a bot process dies](bot-runner.md#when-a-bot-process-dies). It adds `error` with code `cli-exited`, a `deny` for each permission request that has no answer, `tool.end` with outcome `cancelled` for each call still open, and `turn.end` with reason `error`. All of them are saved in one transaction, and the turn gets its `ended_at`.

The server also closes every call that no `tool.end` has closed, even when its turn ended long ago, such as a background command. A server start means a fresh bot runner, so no process from an earlier run is alive. Each such call gets `tool.end` with outcome `cancelled`. The server tells calls apart by bot, `epoch` and `run`, because an adapter reuses call ids across runs, and the `run` counter starts again at 1 at each server start. The server logs how many turns and calls it closed.

Boot repair reads each saved event through the same versioned reader that the replay uses. A row it can't read, because its `format` is unknown or its payload doesn't match its format, is skipped. The server logs `boot repair skipped a saved event it can't read` with the row's id and format, and it never turns an unreadable row into a cancellation. The skipped row doesn't stop the server from starting.

### Retention

The server keeps every turn and event. Nothing prunes them yet, so the table grows with every token a bot writes. Pruning is later work. A client whose cursor is more than one behind the oldest retained event gets a `resync`.

## Rules

- Migrations only go forward. To undo a change, write a new migration.
- Never edit, rename or reorder a migration that has merged into `main`. A server refuses a database whose recorded name doesn't match its own migration with the same version.
- Versions start at 1 and go up by one, in list order. The runner refuses a list with a gap.
- Put no `BEGIN`, `COMMIT`, `ROLLBACK` or `PRAGMA foreign_keys` in a migration. The runner runs every pending migration in one transaction.
- A server refuses a database that has more migrations than it knows. Run a newer server, or restore a backup.
- If a migration fails, the whole run rolls back and the server doesn't start. The database stays at the version it had before.
