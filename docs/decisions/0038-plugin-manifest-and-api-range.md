# 0038. A plugin's manifest is `aphelion-plugin.json`, checked with Zod 4, and its API range is checked with the `semver` package

- Status: Proposed
- Date: 2026-11-22
- Proposed by: the M0-13a plugin manifest PR ([#99](https://github.com/jcore9/Aphelion/issues/99))
- Answers: M0-13a's choices of manifest file, schema library and semver range check, under the M0 plan's [Keeping it extensible](../plan/milestones/M0-foundations.md#keeping-it-extensible) rules 1, 4 and 5

## Context

M0-13a defines the manifest that every plugin author writes first. The M0 plan sets three rules for it:

- Rule 1. Plugin authors see `@aphelion/plugin-sdk` only. [Decision 0023](0023-scaffold-toolchain.md) limits that package to web-standard APIs, so the code runs in Bun, in Node (Electron's main process) and in a browser. `Bun.semver` is Bun-only, so it can't be used.
- Rule 4. One manifest declares everything a plugin adds and needs. The host reads permissions from there and nowhere else.
- Rule 5. Each plugin declares the plugin-API range it supports, and the host checks it.

Three choices follow: where the manifest lives and in what format, which library checks its fields, and what checks the API range.

## Options

### Where the manifest lives

| | A separate `aphelion-plugin.json` | An `aphelion` key in `package.json` | A separate YAML file |
| --- | --- | --- | --- |
| Editor checks as you type | Yes, through its `$schema` field | Only through a published schema catalog | Needs an editor extension |
| What the host must read | One small file | All of `package.json`, which also holds scripts and dependencies | One small file, plus a YAML parser in the SDK |
| Duplication | The id, version and entry repeat what `package.json` says | None | Same as JSON |
| Format owner | Aphelion | npm and Aphelion | Aphelion |

### Schema library

[Decision 0025](0025-config-schema-and-format.md) measured Zod 4, Valibot, TypeBox and ArkType for the config files and chose Zod 4. It also exports JSON Schema, which editors use, and M0-13d can generate the API reference from the same types. No new measurement was needed.

### API-range check

Each candidate was run on Bun 1.4.5 on 2026-11-22, on the project's 4-core VM. Correctness compares each candidate with the `semver` package, which is npm's own implementation. The test used 19 valid ranges, such as `^0.1`, `0.x`, `*`, `1.2.3 - 2.0.0` and `^0.1.0-beta.1`, against 8 versions, which is 152 checks. Size is a minified browser bundle of the two functions used. Load time is the bundle run 20 times in new processes. An empty Bun process takes 7 ms on this VM.

| | `semver` 7.8.6 | `compare-versions` 6.1.1 | A small range check written here |
| --- | --- | --- | --- |
| Disagreements with npm on 152 checks | 0, by definition | 20, on `0.x`, `*`, `~>` and pre-release ranges | 72. It handles only `^`, `~`, comparators and `\|\|`. |
| Tells a malformed range apart | Yes, `validRange` returns `null` | Partly. `^0.1.0.0` and `^01.0.0` pass. | Yes, for the subset it knows |
| Runs outside Bun | Yes. CommonJS, which Bun, Node and bundlers load. One guarded read of `process.env` for debug output. | Yes, ES module | Yes |
| Minified size, gzipped | 29 KB, 9.7 KB | 1.8 KB, 0.9 KB | 0.8 KB, 0.5 KB |
| Load time | 11 ms | 7 ms | 7 ms |
| Upkeep | npm maintains it | One maintainer | Ours |

`Bun.semver` agreed with npm on all 152 valid-range checks. It also returned `true` for malformed ranges such as `banana`, `^` and `latest`, and it has no way to tell a malformed range apart. A host that used it would accept a plugin with a broken range.

## Decision

- **The manifest is `aphelion-plugin.json`**, in the plugin's folder next to `package.json`. It is JSON, so editors check it through `$schema` and the SDK needs no YAML parser. The host reads one small file it owns, and never has to trust the rest of `package.json`.
- **Zod 4 checks it**, as [decision 0025](0025-config-schema-and-format.md) chose for the config. The SDK exports the schema, and a test keeps `plugin-manifest.schema.json` in step with it.
- **The `semver` package checks the API range.** Plugin authors already write npm ranges in `package.json`, and `semver` is the code that defines them, so the range in a manifest means what the author expects. The 29 KB and 4 ms of load time are paid once, when the host loads a plugin.
- **Two extra rules sit on top of npm's grammar.** A blank range, and a blank part between `||` signs, are errors. npm reads a blank as "any version", so `^0.1.0 ||` would accept every host.
- **Returned errors never echo the manifest.** Each issue gives the field's path and a fixed reason. An unknown field is reported by the object that holds it. The host logs these issues, and a hostile manifest must not be able to write into the logs. This holds for the issues `parsePluginManifest` returns. The `semver` package has its own debug output: when `NODE_DEBUG` includes `semver`, it prints each range it reads to standard error. The host must not set `NODE_DEBUG=semver`.
- **Every text field has a length limit**, checked before any other rule. `api` is capped at 256 characters, the same limit `semver` uses for a version, so a huge range never reaches `semver`. In review, a 6 MB invalid range took 2.8 s to reject without the cap. The other caps are in the [manifest reference](../reference/plugin-manifest.md#fields). The plugin runner (M0-13b) also caps the file's size in bytes before it parses the JSON.
- **The plugin's own `version` is strict semver.** A pattern from semver.org and `semver.valid` both check it, so the parser, the JSON Schema and `semver` agree. `1.0.0-rc.01` is refused, because semver forbids leading zeros in a number.
- **`entry` is a plain relative path.** Parts joined by `/`, each made of letters, digits, `_`, `.`, `@`, `+` and `-`, with no `.`, `..` or empty part. That rules out URLs, absolute paths in POSIX and Windows form, backslashes and control characters. The plugin runner (M0-13b) must still check that the resolved file stays inside the plugin's folder, including through symbolic links.
- **UI slots are a permission**, decided by the owner on 2026-11-22. A plugin lists them in `permissions.uiSlots`, and the owner grants each one, the same as secrets and network hosts. Content shown inside the chat can reveal what is in the chat. Secret schemes stay a contribution, because they offer something and grant the plugin nothing.
- **`*` is allowed as the `api` range**, decided by the owner on 2026-11-22. It skips the compatibility check, so the plugin may break without warning when the plugin API changes. The reference says so.
- **The plugin API starts at version 0.1.0**, kept as `pluginApiVersion` in the SDK.

## Consequences

- `@aphelion/plugin-sdk` gains three dependencies: `zod`, `semver`, and `@types/semver` for development.
- A plugin's id, version and entry repeat fields of its `package.json`. The plugin template (M0-13e) can generate the manifest, or a test there can check that the two agree.
- The manifest declares permissions and contributions, but nothing enforces them yet. M0-13b reads the file and refuses bad plugins, M0-13c stores and enforces the grants, and M0-14 routes secret references to the backend that lists their scheme.
- Event names and UI slot names are checked for shape only. When the protocol (M0-09) and the client (M5) define them, the check can tighten to the known names, which is a breaking change to the plugin API.
- Plugin ids such as `con` and `nul` are reserved file names on Windows. Aphelion runs on Linux only ([decision 0011](0011-ubuntu-lts.md)), so they are allowed. A Windows host would have to refuse them.
- If `semver`'s size ever matters, for example in a browser bundle, `compare-versions` is the fallback, with the differences above.
