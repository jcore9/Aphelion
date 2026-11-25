# 0007. Bun is the server runtime and package manager; Vitest runs the tests

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amends: the plan's Open decisions ("TypeScript on Node.js LTS") and M0-04 ("pnpm workspaces ... Vitest")

## Context

The plan recorded TypeScript on Node.js LTS as decided, and M0-04 specifies pnpm workspaces and Vitest. The owner revisited the runtime before any code existed. The realistic options for a long-running Linux server that spawns CLIs, uses SQLite and speaks JSON-RPC were Node.js LTS, Bun and Deno 2.

| Option | For | Against |
| --- | --- | --- |
| Node.js LTS | Same runtime as Electron; every SDK the plan uses targets it first; stable release schedule | Slower startup, installs and tests; younger permission model |
| Bun | Fast startup, installs and tests; runs TypeScript natively; `bun build --compile` makes one self-contained binary; Claude Code itself ships on it | Node compatibility is good but not complete; a second runtime next to Electron's Node; faster-moving releases |
| Deno 2 | Strongest built-in sandbox; native TypeScript; single-binary builds | Node compatibility layer adds edge cases; same two-runtime issue; smaller server ecosystem |

For the toolchain, the options were Bun for everything, Bun for the runtime and installs with Vitest for tests, or Bun for the runtime only with pnpm and Vitest.

## Decision

- **Runtime:** Bun runs the server, the CLI, headless mode and server plugins. The Bun version is pinned in the repo and in CI, and the CLIs' auto-update stays off as the plan requires.
- **Packages:** Bun workspaces replace pnpm workspaces. `bun.lock` is committed.
- **Tests:** Vitest stays as the test runner, which keeps the tests portable and gives the best React component testing.
- **Bun-only APIs** (`bun:sqlite`, `Bun.serve`, `Bun.spawn`, `Bun.$`, `Bun.file` and the like) are allowed only inside small adapter modules behind the plan's interfaces: the store, the process spawner, the HTTP and WebSocket server, and packaging. A lint rule blocks the `bun:` imports and the `Bun` global everywhere else.
- **Shared packages** (`protocol`, `plugin-sdk`) use only web-standard APIs, so they run unchanged in Bun, Node (Electron's main process) and the browser.

## Consequences

- Moving back to Node later means rewriting the adapter modules, not the codebase: days, not weeks.
- **Vitest and Bun.** Vitest normally runs tests on Node, so tests of the Bun adapter modules may need to run under Bun's runtime, or through `bun test` for those modules only. The M0-03 spike answers which.
- **SDK compatibility is unproven on Bun.** The MCP, ACP, 1Password (`@1password/sdk`) and Bitwarden (`@bitwarden/sdk-napi`) SDKs and the Claude ACP adapter must each be checked. This is added to M0-03, and M0-04 waits for that answer. If one doesn't work, the spike says so and the owner decides between a workaround, running that piece on Node, or reverting this record.
- **Headless packaging** is simpler: `bun build --compile` gives one binary with no GUI libraries for M0-03 to test.
- **Two runtimes in the desktop app.** Electron's main process runs Electron's Node, and the server runs as a separate Bun process ([decision 0009](0009-electron-desktop-shell.md)).
- M0-04's acceptance criteria change from pnpm to Bun workspaces, and M0-07's driver decision now includes `bun:sqlite` behind the store interface.
- When M0-16 moves the plan into the docs site, it updates the Open decisions row and M0-04's row.
