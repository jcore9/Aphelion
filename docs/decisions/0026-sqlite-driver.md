# 0026. The store uses `bun:sqlite` in an adapter, and migrations are TypeScript modules

- Status: Proposed
- Date: 2026-11-21
- Proposed by: orchestrator, in the M0-07 store PR ([#9](https://github.com/jcore9/Aphelion/issues/9))
- Answers: the driver **DR** in the M0 plan's M0-07 design note

## Context

The M0 plan asks M0-07 to choose the SQLite driver: `bun:sqlite` inside the store adapter, or a portable driver. Either way it sits behind the store interface ([decision 0007](0007-bun-runtime.md)).

The driver has to work in three places:

- The Bun 1.4.5 runtime.
- Vitest's `threads` pool under `bun --bun vitest run`, which is how the tests run ([decision 0023](0023-scaffold-toolchain.md)).
- A `bun build --compile` binary with no `node_modules` beside it, because the server ships as one compiled binary ([decision 0021](0021-container-init-and-secret-handoff.md)).

The migrations need a format that reaches the compiled binary, too.

## Options

Each driver ran the same check on 2026-11-21. The check opens a file created with mode 0600, switches it to WAL, runs a multi-statement script that creates a table and a `BEFORE UPDATE` trigger, rolls back a transaction that the trigger aborts, and reads the modes of the database, `-wal` and `-shm` files.

| | `bun:sqlite` | `node:sqlite` | `better-sqlite3` 13.2.0 |
| --- | --- | --- | --- |
| Bun 1.4.5 | Pass | Pass | Pass |
| Vitest 5.1.1, `threads` pool | Pass | Pass | Pass |
| Compiled binary, `node_modules` hidden | Pass | Pass | Fails: "Cannot find module `.../better_sqlite3.node`". Passes when the adapter imports the platform's prebuilt `.node` file and passes it as `nativeBinding`. |
| Node 24 | No | Pass | Pass |
| SQLite version | 3.54.1 | 3.54.1 | 3.54.1 |
| Dependencies added | None | None | One, with a native addon per platform |
| Lint | Allowed only in `src/adapters/` | Allowed anywhere in `server` | Allowed anywhere in `server` |

All three drivers wrote the `-wal` and `-shm` files with the same mode as the database file. When SQLite creates the database file itself, the mode is 0644 under umask 0002, so the adapter creates the file first.

For the migration format:

| | SQL files | TypeScript modules that export the SQL as a string |
| --- | --- | --- |
| Bun 1.4.5, `import sql from "./0001.sql" with { type: "text" }` | Pass | Pass |
| Compiled binary | Pass, embedded by the import | Pass, bundled like any module |
| Vitest | Fails: Vite tries to parse the `.sql` file as JavaScript | Pass |

## Decision

`bun:sqlite`, in `packages/server/src/adapters/sqlite.ts`. It is the driver that decision 0007 already names, it passes in all three places with no dependency, and it is Bun's own driver, so it moves with the pinned Bun version. The rest of the server uses the `Database` interface in `packages/server/src/store/database.ts` and never imports the driver.

`node:sqlite` is the fallback. Its API is close to `bun:sqlite`, so a move to Node replaces one adapter file. `better-sqlite3` is out, because the compiled binary needs a per-platform native file wired in by hand.

Migrations are TypeScript modules. Each one exports a `Migration` with a `version`, a `name` and the `sql`, and `packages/server/src/store/migrations/index.ts` lists them in order. The bundler puts them in the binary, and Vitest loads them unchanged.

The runner:

- Records each applied migration in a `schema_migrations` table, with its version, its name and the time it ran.
- Runs every pending migration in one `BEGIN IMMEDIATE` transaction. If a migration fails, the whole run rolls back, and the database stays at the version the previous server knew.
- Refuses a database that has recorded more migrations than the code knows, and one where a recorded name doesn't match the code's migration with that version.

The adapter opens every connection with `journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`. It fails if SQLite can't switch to WAL.

## Consequences

- Tests of the store run only on Bun. That is already true of the whole suite.
- A migration can't change `PRAGMA foreign_keys`, because the runner holds a transaction and SQLite ignores the pragma inside one. A table rebuild that needs foreign keys off gets its own runner support when a migration first needs it.
- The runner records names but not a checksum of the SQL. An edit to a shipped migration that keeps its name goes unnoticed, so the rule against editing shipped migrations rests on review. [The store reference](../reference/store.md) states the rule.
- A second process, such as `aphelion device add` run through `docker compose exec` in M0-10b, can write to the same database. The busy timeout makes it wait for the server's write lock instead of failing at once.
