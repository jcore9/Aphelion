# Aphelion server plugin

This folder is an Aphelion plugin with a server part. The server part runs as its own process next to the Aphelion server and talks to it through `@aphelion/plugin-sdk`.

## Files

| File | What it is |
| --- | --- |
| `aphelion-plugin.json` | The manifest: the plugin's id, version, and the permissions it asks the owner for. |
| `src/plugin.ts` | The plugin itself. `start` runs once the server has started the plugin. |
| `src/plugin.test.ts` | Tests that run the plugin against a fake server, `createTestHost`. |
| `src/index.ts` | Connects the plugin to the server over its standard input and output. |
| `vendor/` | The plugin SDK this plugin was created with. Keep it with the plugin. |

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Installs the SDK and the tools. Run it once. |
| `bun run test` | Runs the tests. |
| `bun run typecheck` | Checks the TypeScript types. |
| `bun run build` | Writes `dist/server.mjs` and `dist/aphelion-plugin.json`. |
| `bun run watch` | Rebuilds `dist/server.mjs` whenever a file in `src/` changes. |

`dist/` is the folder you install on the server. It holds everything the plugin needs, so it works without `node_modules`.
