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
| `bun.lock` | The exact versions `bun install` chose. `bun install` writes it the first time. Commit it. |
| `.github/workflows/ci.yml` | Runs the type check, the tests and the build on GitHub for every push and pull request. |
| `.github/workflows/release.yml` | Publishes a release on GitHub when you push a tag such as `v0.2.0`. |

## Commands

| Command | What it does |
| --- | --- |
| `bun install` | Installs the SDK and the tools. Run it once. |
| `bun run test` | Runs the tests. |
| `bun run typecheck` | Checks the TypeScript types. |
| `bun run build` | Writes `dist/server.mjs` and `dist/aphelion-plugin.json`. |
| `bun run watch` | Rebuilds `dist/server.mjs` whenever a file in `src/` changes. |
| `bun run package` | Packs `dist/` into `release/aphelion-plugin.tar`. Run `bun run build` first. |

`dist/` is the folder you install on the server. It holds everything the plugin needs, so it works without `node_modules`.

## Releases

Aphelion can update the plugin from its GitHub releases. Set `repository` in `aphelion-plugin.json` to the repository on GitHub, such as `"repository": "octo-org/hello-plugin"`, and commit `bun.lock` and `vendor/`.

To publish a version:

1. Set `version` in `aphelion-plugin.json`, such as `0.2.0`, and commit it.
2. Tag the commit with the same version and a `v` in front, and push the tag.

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

`release.yml` then checks that the tag matches `version`, runs the type check, the tests and the build, and packs `dist/` into `aphelion-plugin.tar`. GitHub signs a record of that build, an artifact attestation, which Aphelion checks before it installs the update. The release gets two files: `aphelion-plugin.tar` and the attestation, `aphelion-plugin.tar.sigstore.json`. A version with a `-`, such as `0.2.0-rc.1`, is published as a pre-release, and Aphelion doesn't install it.
