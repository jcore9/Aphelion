# 0023. The scaffold lints with ESLint and typescript-eslint on TypeScript 6.0, and formats with Prettier

- Status: Proposed
- Date: 2026-11-21
- Proposed by: orchestrator, in the M0-04 scaffold PR ([#5](https://github.com/jcore9/Aphelion/issues/5))
- Answers: the linter **DR** in the M0 plan's M0-04 design note

## Context

The M0 plan asks M0-04 to choose a linter, either ESLint with typescript-eslint or Biome. It also asks that choice to allow for the token lint rule that M5-02 adds later.

The lint config carries more than style. It enforces boundaries that decisions depend on:

- [Decision 0007](0007-bun-runtime.md) allows Bun-only APIs only in adapter modules, and allows only web-standard APIs in `protocol` and `plugin-sdk`.
- [Decision 0022](0022-agent-network-boundary.md) bans file reads under the agents root outside the no-follow helper. M4-02 writes that rule.
- M5-02 bans raw style values in components.

The linter therefore needs path-scoped bans on imports and globals, type-aware rules for async code, and a stable API for custom rules.

## Options

Three linters were run on 2026-11-21 against the same fixture files. Oxlint was added because it runs typescript-eslint's type-aware rules on TypeScript 7.

| | ESLint 10.15 with typescript-eslint 8.73 | Biome 2.6.8 | Oxlint 1.94 with tsgolint |
| --- | --- | --- | --- |
| `bun` and `bun:*` imports, and the `Bun` global, outside adapters | Caught | Caught | Caught |
| `globalThis.Bun` | Caught by the built-in `no-restricted-properties` | Needs a GritQL plugin | Needs a JS plugin |
| `node:` imports and Node globals in web packages | Caught | Caught | Caught |
| Seven floating or misused promise cases | 7 of 7 | 7 of 7, in the unstable `nursery` group | 7 of 7 |
| Custom rules, such as the token lint | Stable rule API | GritQL patterns | JS plugins, documented as alpha and outside semver |
| TypeScript version | 6.0 only. The peer range is `<6.1`. | Any | 7.0 |
| Formatter | Needs Prettier | Built in | `oxfmt` 0.79, or Prettier |
| Time on the fixtures | 1.6 s | 0.2 s | 0.2 s |

## Decision

ESLint with typescript-eslint, on TypeScript 6.0.3, with Prettier for formatting. It is the only option where the boundary rules, the type-aware rules and the custom-rule API are all stable. The boundary rules use ESLint's built-in `no-restricted-imports`, `no-restricted-globals` and `no-restricted-properties`, so no custom rule is needed yet.

The rest of the toolchain:

- **Bun 1.4.5**, pinned in the root `package.json` `packageManager` field, which CI reads. The M0-03 spike measured every result on 1.4.5, and `@types/bun` 1.4.5 matches it.
- **Exact versions.** `bunfig.toml` sets `exact = true`, so `bun add` writes exact versions. `bun.lock` is committed.
- **TypeScript 6.0.3.** TypeScript 6.0 and 7.0 check the same language, and 7.0 is the faster Go port. The repo moves to 7 when typescript-eslint supports it.
- **Lint rules.** typescript-eslint's `strictTypeChecked` set, plus the boundary rules below.
- **Prettier 3.10** with default settings, for code and config. Markdown is excluded, so existing docs keep their layout.
- **Vitest 5.1.1**, run as `bun --bun vitest run` with `pool: "threads"`, as the M0-03 spike found. `vitest.config.ts` refuses to start on any runtime other than Bun, so running Vitest on Node fails with a clear message.
- **Typecheck.** Each package runs `tsc --noEmit` through `bun run --filter`. The root `tsconfig.json` covers the config files at the root.
- **CI.** One workflow runs three checks on every pull request: `lint`, `typecheck` and `test`. Actions are pinned to commit SHAs, and the token can only read.
- **Client.** React, Tailwind and Vite arrive with M5-01 ([decision 0008](0008-react-and-tailwind.md)). Until then, `@aphelion/client` is a typed package with browser types.

The boundary rules:

| Code in | Can't use |
| --- | --- |
| Every package, outside an adapter module | `bun`, `bun:*`, `Bun`, `globalThis.Bun` |
| `protocol`, `plugin-sdk` and `client` | The above, plus Node built-in modules, `node:*`, Node globals such as `process` and `Buffer`, and imports of `@aphelion/server`, `@aphelion/cli` or `@aphelion/client` |
| `protocol` and `plugin-sdk` | The above, plus `window` and `document` |

Adapter modules live in `packages/server/src/adapters/` and `packages/cli/src/adapters/`. The `tsconfig.json` files of `protocol`, `plugin-sdk` and `client` don't load Bun or Node types, so typecheck also rejects the Bun and Node globals there.

`lint-boundaries.test.ts` runs ESLint with the real config and checks each rule. It pairs each banned case with a case where the same code is allowed.

## Consequences

- Lint takes longer than with the Rust-based tools. If it slows work down, Oxlint accepts the same rule names, and its JS plugins use the ESLint rule API, so a move is mostly a config change.
- TypeScript 7 waits for typescript-eslint.
- M4-02's no-follow rule and M5-02's token rule are written as ESLint rules, each with its own test cases.
- A new adapter folder needs an entry in `adapterModules` in `eslint.config.ts` and a test case.
- M0-05b can require the `lint`, `typecheck` and `test` checks by name in branch protection.
