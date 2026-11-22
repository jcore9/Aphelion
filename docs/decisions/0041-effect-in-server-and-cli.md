# 0041. The server and the CLI use the Effect library, and nothing else does

- Status: Accepted (decided by the project owner on 2026-11-22)
- Date: 2026-11-22
- Decided by: project owner
- Proposed by: the docs PR that records this decision
- Answers: which library structures the server's errors, retries, services and secrets, before M0-10a writes the first long-running code
- Amends: the plan's "Keeping it extensible", item 6, which now points here

## Context

The server is a long-running program. It starts an HTTP server, a database, agent processes and a secrets broker. It must stop each of them cleanly, retry the ones that fail, and never leak a secret into a log. Plain TypeScript can do all of that, but each piece needs hand-written code: a class for each error, a loop for each retry, a shutdown list, a wrapper for each secret.

[Effect](https://effect.website) is a TypeScript library that provides those pieces in one consistent style. The owner looked at how T3 Code uses it. T3 Code is the app that runs this project's agents. The T3 Code release on the dev box (0.1.12) ships `effect` 4.1.5. [Decision 0034](0034-vendor-protocol-per-cli.md) cites the same install for how T3 drives each agent CLI.

T3 is the example that showed what Effect is worth. It is not a template. T3 targets Node, carries both Zod and Effect's own schema library, and uses most of Effect's modules. Aphelion needs none of those choices to follow.

Effect code reads differently from ordinary TypeScript, and the owner is not a TypeScript developer. The rule on readability below is part of the decision for that reason.

### Effect terms used on this page

- **Effect.** A value that describes a piece of work, such as "read this file" or "call this URL". Nothing happens until the program runs it. An Effect also records, in its type, what can go wrong and what it needs in order to run.
- **Tagged error.** An error class that carries a fixed label, such as `"StoreLocked"`. Code can then handle each kind of failure by its label, and the compiler can check that none was forgotten.
- **Schedule.** A rule for repeating or retrying work: "try again up to five times, waiting longer each time".
- **Service.** A named capability that code asks for instead of building, such as "the store" or "the clock". Tests can give code a fake one.
- **Layer.** A recipe that builds a service, and the services it depends on, in the right order. It also says how to shut them down. The program provides its Layers once, at startup.
- **Redacted.** A wrapper around a secret value. Printing it, logging it or converting it to JSON gives `<redacted>`. Code must call `Redacted.value` to read the real value.

## Options

| | No Effect | Effect in the server and CLI only | Effect in every package | Small helper modules only |
| --- | --- | --- | --- | --- |
| Errors, retries, shutdown | Hand-written, per feature | One library for all three | Same | Hand-written, in our own helpers |
| Plugin authors | Plain TypeScript | Plain TypeScript | Must learn Effect, and the plugin API follows Effect's major versions | Plain TypeScript |
| Protocol and client | Plain | Plain | Effect in the browser bundle | Plain |
| Reading the code | Familiar | Harder in the server and CLI | Harder everywhere | Familiar |
| Cost | Most code, most chances to differ between features | One dependency, about 75 MB installed | The same, plus a plugin API tied to a library | We build and maintain a small Effect |

The owner chose the second column. Plugin authors and client code never need Effect, which keeps rule 1 of "Keeping it extensible" in [the M0 plan](../plan/milestones/M0-foundations.md#keeping-it-extensible) true.

## Decision

The server and the CLI use Effect. Each Effect module is adopted when a real issue needs it and it earns its place there. No module is required because T3 uses it.

**Scope.** Only `packages/server` and `packages/cli` use Effect. `packages/protocol`, `packages/plugin-sdk` and `packages/client` stay plain TypeScript. Their schemas stay in Zod 4 ([decision 0025](0025-config-schema-and-format.md) and [decision 0037](0037-protocol-frames-in-zod.md)), so [decision 0038](0038-plugin-manifest-and-api-range.md) is unaffected.

**Existing code converts as it is touched.** New server code uses Effect from now on. The config loader (#121), the store (#119) and logging (#129) switch to Effect in the first PR that changes them. There is no rewrite PR.

**The modules the next issues are likely to use.**

- Tagged errors and `Effect.retry` with a Schedule. Agent processes, the database and network calls all fail in ways that call for a retry or a timeout.
- Services and Layers. The plan names the swappable edges of the server: the store, the process spawner and the HTTP server ([decision 0007](0007-bun-runtime.md)). A service is the interface, and a Layer is the adapter behind it.
- `Redacted`, as the base for M0-14a's `Secret` ([#103](https://github.com/jcore9/Aphelion/issues/103)). Aphelion adds two things on top. The logger's `maskSecretValue` hook from #129 masks the value. A `Secret` also refuses to be written into the database or sent over a process pipe, and refuses when code tries.
- `@effect/platform-bun`'s HTTP server, for M0-10a ([#97](https://github.com/jcore9/Aphelion/issues/97)).

**Rules.**

1. **One pinned version.** `effect` and every `@effect/*` package use one exact version, and they change together in one PR. No `^` ranges. The peer range of each `@effect/*` package is `effect ^4.1.5`, so a mismatch fails at install.
2. **Bun-only packages stay in adapters.** `@effect/platform-bun` and `@effect/sql-sqlite-bun` call Bun-only APIs inside. They count as Bun APIs under [decision 0007](0007-bun-runtime.md) and [decision 0023](0023-scaffold-toolchain.md). Import them only from `packages/server/src/adapters/` and `packages/cli/src/adapters/`. The lint rule bans them everywhere else, and `lint-boundaries.test.ts` checks that. Plain `effect` imports are allowed in the rest of the server and the CLI.
3. **Zod stays where it is.** `protocol` and `plugin-sdk` keep Zod, because they stay plain. For the server's own code, whether to use Effect's `Schema` or Zod is **not decided here**. It is an open question for the owner, listed below.
4. **Explain Effect in the PR.** Every PR that adds Effect code explains its Effect parts in plain words under **How to review**: what each service is, which errors can happen, and what a Layer wires together. A reviewer who has never seen `pipe` or `Effect.gen` must be able to follow the PR from that section.

## What was measured

All runs used Bun 1.4.5 on the dev box on 2026-11-22, with `effect` 4.1.5, `@effect/platform-bun` 4.1.5, `@effect/sql-sqlite-bun` 4.1.5, `@effect/vitest` 4.1.5 and `vitest` 5.1.1. Every version was pinned exactly. The probe lived outside the repo and was deleted.

| Check | Result |
| --- | --- |
| A program with `Effect.gen`, a `Data.TaggedError`, `Effect.retry` with a `Schedule`, a Layer-provided service and `Redacted`, run with `bun` | Passed. It retried twice and succeeded on the third try, caught the error by its label, and `String(secret)` gave `<redacted>`. |
| `@effect/platform-bun` HTTP server on port 0, one `fetch` against it | Passed. Status 200 and body `pong`. |
| `@effect/vitest` `it.effect` under `bun --bun vitest run` with `pool: "threads"` ([decision 0023](0023-scaffold-toolchain.md)) | Passed, with one thing to know. `it.effect` runs on a fake clock, so a test with a real wait, such as a retry delay, hangs until the 5-second timeout. Use `it.live` for those tests, or advance the fake clock with `TestClock`. Both tests passed with that split. |
| The same program and the HTTP server inside a `bun build --compile` binary ([decision 0021](0021-container-init-and-secret-handoff.md)) | Passed. Both binaries ran and gave the same output as under `bun`. |
| Binary size | 109.2 MB with no Effect (that is Bun itself). 109.3 MB with the program. 109.6 MB with the HTTP server added. Effect adds about 0.1 MB, and the HTTP server about 0.35 MB more. |
| Install size | 75 MB in `node_modules` for the three runtime packages, 69 MB of it in `effect`. `@effect/vitest` adds 0.6 MB. This is install size only. Compiled binaries carry just the modules they import. |

Two things the probe did not test: `@effect/sql-sqlite-bun` against a real database file, and Effect's `Schema` module. The PR that first adopts either one measures it first.

One more fact from the probe. `effect` 4 ships its HTTP router and its CLI parser as sub-paths of the one package, `effect/http` and `effect/cli`. A new module does not mean a new dependency. It does mean a module to learn, so rule 4 applies to each one.

## Consequences

- Rule 1 of "Keeping it extensible" is unchanged, and item 6 of that list links here. Plugin authors write plain TypeScript against `plugin-sdk`, and the plugin API does not follow Effect's major versions.
- `eslint.config.ts` bans `@effect/platform-bun` and `@effect/sql-sqlite-bun` outside the adapter folders. This PR adds the ban and its test.
- M0-10a builds the HTTP server on `@effect/platform-bun` in an adapter. That PR is the first user, and it checks WebSocket support there.
- M0-14a builds `Secret` on `Redacted`. The canary test from the M0 plan still applies: a canary value must not appear in logs or in the database file.
- The server and the CLI become harder to read for someone who doesn't know Effect. The cost is paid in the PR explanations from rule 4. If reviews stay slow after M0-10a and the store land, revisit this record.
- Effect's major version moves on its own schedule. A major upgrade is one PR that changes every `effect` and `@effect/*` pin at once.
- Converting the config loader, the store and logging happens in the PRs that touch them. Until then those three stay as they are, and a reviewer should not ask a PR to convert code it doesn't change.

## Open question for the owner

**Effect `Schema` or Zod for the server's own validation.** The server's config is validated with Zod today ([decision 0025](0025-config-schema-and-format.md)). Effect has its own schema library. Using it would give one library for the server's checks and errors. Keeping Zod would give one style across the server and the packages that share it. T3 carries both. This record does not choose. The owner decides before the first PR that converts config to Effect, because that PR must pick one.
