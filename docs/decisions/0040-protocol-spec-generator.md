# 0040. A test renders the protocol spec and the frame JSON Schemas from the Zod schemas, and fails when the committed files are stale

- Status: Accepted (approved by merging #133 on 2026-11-22)
- Date: 2026-11-22
- Proposed by: the M0-09b protocol spec PR ([#96](https://github.com/jcore9/Aphelion/issues/96))
- Answers: which generator turns the protocol schemas into the published spec, and how CI catches a stale spec

## Context

Clients and plugin authors learn the wire format from the docs. A hand-written list of fields drifts from the code the first time someone adds a command and forgets the page. M0-09b asks for a spec that is generated from the protocol's definitions, published on the docs site, and checked by CI.

The input is fixed by [decision 0037](0037-protocol-frames-in-zod.md). The frames are Zod 4 schemas in `packages/protocol/src`, the commands and events live in one registry, and `z.toJSONSchema` exports both frame unions. `@aphelion/protocol` uses only web-standard APIs ([decision 0023](0023-scaffold-toolchain.md)), and the lint rules forbid `node:` imports anywhere in the package, tests included.

The repository already has one generated reference. The config reference from #121 renders Markdown from the config schemas in `packages/server/src/config/reference.ts`. Its test compares the result with the committed file through Vitest's `toMatchFileSnapshot`, and `bun --bun vitest run -u` rewrites the file. The plugin manifest's JSON Schema from #131 uses the same check.

The published spec contains:

- the protocol version and the envelope, which is the `v` and `type` fields that every frame has;
- each frame type, by direction, with a table of its fields, their types, whether they are required, and what they mean;
- every registered command with its payload and result, and every registered event with its payload;
- the shared types `CommandId`, `StreamId` and `Cursor`;
- the error codes.

## Options

Each measurement was run on Bun 1.4.5 and Node 24 on 2026-11-22.

| | A test with `toMatchFileSnapshot` | A script and a CI diff check | `@adobe/jsonschema2md` 8.0.11 |
| --- | --- | --- | --- |
| Rendering code | One module that turns the JSON Schema and the registry into Markdown | The same module | None to write |
| Stale check | The existing `test` job. Under `CI=true`, a changed page failed the test, and a deleted page failed without being rewritten. | A new CI step that runs the script and then `git diff --exit-code` | Needs the script and the CI step as well |
| How to regenerate | `bun --bun vitest run -u packages/protocol`, the same command as the config reference | `bun run` plus the script's name | The tool's command line |
| Runs on Bun | Yes | Yes | No. It exited with an error on Bun 1.4.5 while it built its index page. It ran on Node 24 only after an `$id` was added to the schema. |
| Output for `client-frame.schema.json` alone | One section per frame type on one page | One page | 22 Markdown files and 805 lines for two frame types, one page per property. 20 of the 22 pages have a title that starts with "Untitled". |
| Fits the docs site | Yes. Links to the JSON Schema files are full GitHub URLs. | Yes | No. It links to the schema files by relative path, which the site's link check refuses. |
| New dependencies | None | None | 102 packages, 8.9 MB |

The tool was installed in an empty folder with `bun add @adobe/jsonschema2md@8.0.11`, which installed 102 packages. It read a copy of `client-frame.schema.json` from `schema/`, with `"$id": "https://example.com/client-frame.schema.json"` added, and it ran as `node node_modules/.bin/jsonschema2md -d ../schema -o ../out -x -` from the install folder. Without the `$id`, Node exited with `ERR_INVALID_ARG_TYPE`. The same command with `bun` in place of `node` exited with code 1, with or without the `$id`. The counts come from `ls out/*.md | wc -l`, `cat out/*.md | wc -l` and `grep -l "^# Untitled" out/*.md | wc -l`, and the size from `du -sh node_modules`. The folder was deleted afterwards.

The off-the-shelf tool reads only the JSON Schema, so it can't use the registry to group fields by command. Its pages would need a rewrite step to fit the site, which costs more than the renderer itself.

A script and a test share the same rendering code. The test reuses the CI job, the regenerate command and the habit that the config reference set. A script adds a workflow step and a second way to regenerate generated files.

The generated spec could also replace the field tables inside the hand-written page, between two markers, as the config reference does. That needs the test to read the hand-written page from disk, and `node:fs` is not allowed in `@aphelion/protocol`. A separate page needs no read. It also keeps the lookup tables apart from the explanation of replay and command ids, which readers use differently.

## Decision

A test in `@aphelion/protocol` renders the spec, and Vitest's `toMatchFileSnapshot` compares it with the committed files.

- `packages/protocol/src/spec.ts` holds `renderSpec` and `schemaFiles`. Both are pure functions that return text. They read `clientFrame`, `serverFrame`, `version` and `errorCodes` from `frames.ts`, and `commands` and `events` from `registry.ts`.
- `packages/protocol/src/spec.test.ts` writes nothing in CI. It compares the output with `docs/reference/protocol-spec.md`, `packages/protocol/client-frame.schema.json` and `packages/protocol/server-frame.schema.json`, and fails when any of them differs.
- `bun --bun vitest run -u packages/protocol` rewrites the files that are out of date.
- The meaning of each field comes from its `.describe()` text in the Zod schema, so the description is in the JSON Schema too. `CommandId`, `StreamId` and `Cursor` carry a `.meta({ id })`, so the JSON Schema names them under `definitions` and the spec links to one entry for each.
- The JSON Schema files are draft-07, the version that editors support best, as with the config and manifest schemas. The package exports them, so another-language client can check frames or generate types from them.
- `docs/reference/protocol.md` stays hand-written. It explains frames, errors, replay, resync and command ids, and links to the spec for the field tables.

## Consequences

- Adding a command or an event now has one more step. The author runs the regenerate command and commits the changed files. A new command changes the spec page and both JSON Schema files, because a client sends its `command` frame and the server sends its `result` frame. A new event changes the spec page and `server-frame.schema.json` only. CI names the stale file when the author forgets.
- A field without a `.describe()` text shows an empty description in the spec. Review catches it, not a check.
- The renderer understands the JSON Schema features that the frames use today: constants, enums, patterns, integer bounds, nullable values, named definitions and nested objects. A new Zod feature in a payload, such as a record or a tuple, renders without its details, as `object` or `list of any`, until `spec.ts` learns it. Revisit the renderer when a payload needs one.
- `client-frame.schema.json` and `server-frame.schema.json` are part of the protocol's public shape from now on. A change to a frame shows up as a diff in them, which makes protocol changes easy to spot in review.
