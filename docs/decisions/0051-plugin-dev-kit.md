# 0051. The plugin dev kit has a stdio entry in the SDK, reloads through the running server, and generates from a checkout

- Status: Proposed
- Date: 2026-11-23
- Proposed by: the plugin dev kit PR ([#106](https://github.com/jcore9/Aphelion/issues/106))
- Answers: how a plugin author writes, tests and reloads a server plugin without writing JSON-RPC by hand
- Amends: [decision 0042](0042-plugin-server-and-client-parts.md) only by adding the author's tools. Nothing in 0042 changes.

## Context

Until #106, a plugin author had to speak the host's JSON-RPC 2.0 messages on standard input and output ([the plugin reference](../reference/plugins.md)). Issue #106 asks for four things: an SDK that hides the messages, a starter template whose tests pass, a dev mode where `aphelion plugin dev` reloads a plugin after each edit, and a 1Password backend built from the template.

Three rules limit the design:

- `packages/plugin-sdk` uses only web-standard APIs. A lint rule fails the build on `node:` imports there ([decision 0023](0023-scaffold-toolchain.md)). The rule also keeps the SDK usable by client parts later.
- A plugin never sees a secret's value ([decision 0042](0042-plugin-server-and-client-parts.md)). Dev mode must not weaken that.
- `@aphelion/plugin-sdk` is `private` and isn't published.

This record settles three choices that the issue leaves open.

## Options

### A. Where the process glue lives

A plugin needs code that reads standard input, writes standard output, and exits. That code needs `node:process`.

1. **One file in the SDK, `@aphelion/plugin-sdk/stdio`, may import `node:process`.** Every other SDK file stays web-standard. A one-file lint exemption cites this record.
   - For: authors write `main(plugin)` and nothing more. Line framing, write backpressure, the 1 MiB line cap and the exit code are written and tested once.
   - Against: one exception to the web-standard rule, which a reader must find.
2. **A stdio adapter in every plugin.** The template carries the glue.
   - For: the SDK has no exception.
   - Against: each plugin copies about forty lines of framing code, and a bug fix reaches none of them.
3. **A separate package for the stdio entry.**
   - For: the SDK package stays pure.
   - Against: a second package to version, pack and vendor, for one file. The rule would hold for the package and say nothing about the file.

### B. How dev mode reloads a plugin

1. **The CLI asks the running server to reload, over a dev-only Unix socket.** A Unix socket is a file that two programs on one machine use to talk. The server opens it only when started with `--plugin-dev FOLDER`, inside its state folder, with mode `0600` so that only `harness` can use it. It reloads only the approved plugin in that folder, through the real plugin host and runner.
   - For: the plugin runs as `aphelion-plugins` with its approved grants, exactly as in production. Later events from the server reach it through the same host. The `aphelion plugin dev` command that the issue names exists.
   - Against: a new door into the server. The socket accepts one request type, `reload`, for one canonical folder, with an approval row whose manifest digest matches. It accepts no approvals and no runner messages. An ordinary deployment opens no socket, and the container contract test checks that.
2. **The CLI starts its own host and runner.**
   - For: no socket on the server.
   - Against: the CLI runs as `harness` and can't start the runner as another user without the launcher's privileged setup, so the plugin would run as `harness`, not `aphelion-plugins`. The CLI would grant the permissions itself, so it would test nothing about approval. It would get no real events once the server sends them, because it isn't the server.
3. **The server watches folders itself.**
   - For: no CLI, no socket.
   - Against: no `aphelion plugin dev` command, which the issue asks for. The server would need a list of watched folders and a way to change it, which is more server surface than one fixed folder.

### C. How a project is generated

1. **A generator in the checkout, `bun run create:plugin`, that packs the SDK into the project.** It copies `templates/server-plugin/`, sets the id, runs `bun pm pack` on `packages/plugin-sdk`, and points `package.json` at the tarball in `vendor/`.
   - For: it works today with exactly the SDK version of the checkout, and it needs no network to generate a project. Installing the project's packages still needs the registry or a package cache. The project is standalone and has no link to the checkout.
   - Against: the author needs a checkout. Each project carries a tarball of the SDK, about 11 KiB.
2. **Publish `@aphelion/plugin-sdk` and offer `bun create aphelion-plugin`.**
   - For: the usual way. No checkout.
   - Against: publishing is the owner's decision about a name, a registry and a support promise on the plugin API. It isn't made.

## Decision

- **A: option 1.** `@aphelion/plugin-sdk/stdio` is the one SDK file that imports `node:process`. `eslint.config.ts` exempts that file and names this record in the message. The exemption allows `node:process` and no other Node import. `lint-boundaries.test.ts` checks that `stdio.ts` may import it and that every other SDK file may not.
- **B: option 1.** The launcher passes `APHELION_PLUGIN_DEV_FOLDER` to the server as `--plugin-dev`. [`deploy/compose.plugin-dev.yaml`](https://github.com/jcore9/Aphelion/blob/main/deploy/compose.plugin-dev.yaml) sets it and mounts the folder read-only. A reload reads the approvals for the folder, stops every plugin approved there and waits until each has stopped, reads the manifest again, and starts the plugin whose `id` it names through the runner. The runner's checks on ownership, write access, ancestors and symbolic links run on every start. A changed manifest leaves the plugin stopped until the owner approves it again.
- **C: option 1.** The generator runs from a checkout and vendors the packed SDK. `bun create aphelion-plugin` waits until the owner decides to publish the SDK. The template's build and the generator's output are tested in CI by `scripts/test-plugin-template.sh`.
- Issue item 4, a 1Password backend built from the template, moves to [#17](https://github.com/jcore9/Aphelion/issues/17). #106 ships the template and the kit that #17 needs.

## Consequences

- Plugin authors write `{ start(ctx) { ... } } satisfies ServerPlugin` and test it with `createTestHost`. The [first plugin guide](../guides/write-your-first-server-plugin.md) walks through it.
- The SDK now holds the wire definitions that the server also uses: method names, the error table, the parameter schemas and the HTTPS URL check. The server imports them. A contract test runs a real SDK plugin against both the real plugin host and the fake host in `/testing`, and checks that they answer the same way. It covers subscriptions, events, network requests and the missing secret operations. Behavior outside those cases can still differ.
- The SDK has one file with a Node import. A later client part must not import `/stdio`.
- The dev socket exists only in dev mode. The reference documents it in [Dev mode](../reference/plugins.md#dev-mode). A host that runs dev mode in production has opened a door that the plain install doesn't have, so the guide tells the author to remove the override afterwards.
- Revisit C when the owner decides to publish the SDK. Then the generator can depend on the published version, and `bun create aphelion-plugin` becomes possible. Revisit B when the server sends real events, to see whether a reload needs to replay one.
