# 0025. Config files are YAML, parsed with the `yaml` package and validated with Zod 4

- Status: Proposed
- Date: 2026-11-21
- Proposed by: the M0-06 config PR ([#8](https://github.com/jcore9/Aphelion/issues/8))
- Answers: the schema library **DR** in the M0 plan's M0-06 design note, and the file format

## Context

M0-06 defines the server's config directory, `/etc/aphelion/` ([decision 0014](0014-filesystem-layout.md)). It needs two choices.

- **A schema library.** The M0 plan requires one that exports JSON Schema, so the docs and editors can use it. An invalid file must fail with an error that names the file and the field.
- **A file format and its parser.** The plan says the agent registry is "Stored as YAML in git". It also says the web client edits the policy file, so the server will write config files as well as read them.

[Decision 0007](0007-bun-runtime.md) allows Bun-only APIs only in adapter modules. A portable library can sit in `packages/server/src/config/` directly.

## Options

Each candidate was run on Bun 1.4.5 on 2026-11-21, on a 4-core VM, against the same agents schema. The schema had six fields, an unknown-key ban, a name pattern and an absolute-path check. The bad document had a bad name, a missing field, a relative path and a misspelled key. Load time is a bundled, minified module that defines the schema, run 20 times in new processes. An empty Bun process takes 5 ms on this VM.

### Schema library

| | Zod 4.6.7 | Valibot 1.5.0 | TypeBox 1.4.7 | ArkType 2.2.10 |
| --- | --- | --- | --- | --- |
| JSON Schema export | Built in, draft-07 or 2020-12 | A second package, `@valibot/to-json-schema` 1.8.0, draft-07 | The schema is JSON Schema | Built in, 2020-12 |
| Errors for the bad document | 4, one per problem | 4, one per problem | 5. The unknown key is reported twice. | 4, one per problem |
| Message for the missing field | `Invalid input: expected string, received undefined` | `Invalid key: Expected "model" but received undefined` | `must have required properties model`, on the parent object | `must be a string (was missing)` |
| Quirks | `startsWith()` exports a non-standard `"format": "starts_with"`. A regex avoids it. | | Paths are JSON pointers (`/agents/1`) | A field's description replaces its type in messages: `must be Agent name` |
| Cross-field checks, such as unique names | `superRefine` | `check` in a pipe | Separate code after the check | `narrow` |
| Minified size | 86 KB, export included | 3 KB, without the export package | 100 KB | 156 KB |
| Load time, bundled | 15 ms | 6 ms | 17 ms | 169 ms |
| Check 500 agents | 0.40 ms | 0.17 ms | 3.05 ms, uncompiled | 0.04 ms |

ArkType's load time is the outlier. It stayed at 169 ms with the module bundled, so it isn't module resolution. Inferred: ArkType builds its built-in type scope at import. Load time matters, because `aphelion config check` and server start pay it on every run. Check time doesn't matter, because a config load checks each file once.

### File format and parser

JSON was ruled out first. It has no comments, and the plan already says YAML. Three YAML parsers were run on the same inputs, with a 500-agent `agents.yaml` (83 KB) for speed.

| | Bun's built-in YAML (`Bun.YAML`) | `yaml` 2.9.1 | `js-yaml` 5.5.0 |
| --- | --- | --- | --- |
| Runs in | Bun only, so an adapter | Any runtime | Any runtime |
| A key twice in one mapping | Accepted. The last value wins. | Error with line and column | Error with line and column |
| A syntax error | `Unexpected token`, with no position | Message with line and column | Message with line and column |
| Two documents in one file | Returns an array | Error | Error |
| Finds the line of a field from a schema error's path | No | Yes, `getIn` plus `LineCounter` | No |
| Edits a file and keeps its comments | No | Yes | No |
| `no`, `yes`, `010`, `12:30` | YAML 1.2. Strings, except `010`, which is 10. | Same | Same |
| Parse 500 agents | 1.7 ms | 27.4 ms | 3.3 ms |
| Minified size, load time | 0 KB, 0 ms | 113 KB, 12 ms | 47 KB, 9 ms |

`yaml` is the slowest, because it builds a full document tree with a source range for every node (inferred). That tree is what maps an error to its line and keeps comments on edit. 27 ms for 500 agents happens once per load.

## Decision

**Zod 4** for the schemas, and **YAML** files parsed with the **`yaml`** package. Both are portable and live in `packages/server/src/config/`, with no adapter.

- **Zod 4** gives the clearest messages with no tuning, one per problem, and exports JSON Schema without a second package. Valibot is smaller and loads 9 ms faster, but its default messages read worse, and its export is a separate package to keep in step. TypeBox reports some problems twice. ArkType's load time is too high for a CLI.
- **`yaml`** is the only parser that maps a schema error back to its line and column, so an error names the file, the position and the field. It is also the only one that can edit a file and keep its comments. The policy editor (M5-09) and the agent management tools (M4-09) need that edit, because the config directory can be a git repo that people also edit by hand. `Bun.YAML` silently keeps the last of two duplicate keys, which could hide a second `version` or a second `policyProfile` in a security file.

How the code uses them:

- A table of config areas in `packages/server/src/config/areas.ts` holds each file's name, schema and migrations. A file's current version is its number of migrations plus one, so the two can't disagree.
- Files are parsed at the boundary into typed config. Unknown fields are errors.
- The JSON Schema files and the field tables in the [config reference](../reference/config.md) are generated from the table. A test fails when the committed copies are out of date.

## Consequences

- The server gains two runtime dependencies, `zod` and `yaml`.
- JSON Schema can't express every rule. Unique agent names are checked by the server only, and the reference says so.
- Migrations run in memory on load. Writing a migrated file back to disk is left for when the server first writes config (M4-09 or M5-09). That code can use the `yaml` document API to keep comments.
- If load time ever matters more than messages, Valibot is the fallback. The area table keeps the schemas in one file, so a move touches `areas.ts` and the error mapping in `load.ts`.
