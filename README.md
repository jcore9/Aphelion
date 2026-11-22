# Aphelion

## Develop

You need [Bun](https://bun.sh) 1.4.5, the version pinned in `package.json`.

1. Install the dependencies:

   ```sh
   bun install
   ```

2. Run the checks that CI runs:

   ```sh
   bun run lint
   bun run typecheck
   bun run test
   bun run docs
   ```

`bun run format` rewrites code to the Prettier style that `lint` checks.

`bun run docs` builds the docs site into `docs/dist/` and fails on a broken internal link. `bun run --filter @aphelion/docs dev` serves it with live reload. [The docs index](docs/README.md) says how the site reads the files.

The workspaces are `packages/server`, `packages/client`, `packages/protocol`, `packages/plugin-sdk`, `packages/cli` and `docs`. Bun-only APIs are allowed only in `src/adapters/` in `server` and `cli`. `protocol`, `plugin-sdk` and `client` use web-standard APIs only. [Decision 0023](docs/decisions/0023-scaffold-toolchain.md) lists the rules, and lint enforces them.
