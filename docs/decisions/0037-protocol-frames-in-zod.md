# 0037. Protocol frames are Zod 4 schemas, and the TypeScript types come from them

- Status: Accepted (approved by merging #126 on 2026-11-22)
- Date: 2026-11-22
- Proposed by: the M0-09a protocol frames PR ([#95](https://github.com/jcore9/Aphelion/issues/95))
- Answers: how `@aphelion/protocol` describes and validates frames, which sets the input for the spec generator that M0-09b chooses

## Context

M0-09a defines the frames that the server and every client exchange. Each side parses incoming frames at the boundary into typed frames. Three constraints shape how the frames are written down:

- `@aphelion/protocol` runs unchanged in Bun, Node and the browser, and its typecheck loads only the ES library ([decision 0023](0023-scaffold-toolchain.md)).
- M0-09b generates the protocol spec from the definitions and fails CI when the spec is stale. The definitions need a path to a machine-readable schema.
- Later milestones add commands and events. Adding one must be a local change.

The server already validates config with Zod 4 ([decision 0025](0025-config-schema-and-format.md)).

## Options

Each measurement was run on Bun 1.4.5 on 2026-11-22. Sizes are a browser bundle from `bun build --minify` of a module the size of the M0 frames.

| | Zod 4.6.7 | `zod/mini` 4.6.7 | TypeScript types with hand-written guards | TypeBox or Valibot |
| --- | --- | --- | --- | --- |
| One definition for the type and the check | Yes, `z.infer` | Yes, `z.infer` | No. The guard and the type can drift. | Yes |
| Machine-readable schema for M0-09b | `z.toJSONSchema`, built in. It exports the nested frame unions. | `z.toJSONSchema`, built in | Needs a separate tool that reads the types, such as `ts-json-schema-generator` | Built in for TypeBox, a second package for Valibot |
| Typechecks with only the ES library | Yes | Yes | Yes | Not tried |
| Bundle size, minified and gzipped | 90 KB and 25 KB | 20 KB and 6.7 KB | No library | Not measured |
| Already in the repo | Yes, in the server | The same package, with a different API style | | No |

## Decision

Zod 4, with the same `zod` version as the server. The frame schemas are the source, and the TypeScript types are derived from them.

- `packages/protocol/src/registry.ts` holds two tables, `commands` and `events`. A command entry has a `payload` schema and a `result` schema. An event entry is its payload schema. Adding a command or an event is one entry there.
- `packages/protocol/src/frames.ts` builds the frame unions from the tables and exports them as `clientFrame` and `serverFrame`. M0-09b can pass these schemas to `z.toJSONSchema`, or to any generator that reads Zod.
- Frames are strict. An unknown field is an error, not dropped, because `v` is the compatibility contract.
- `parseClientFrame` and `parseServerFrame` take the text from the connection and return a typed frame or a typed error. They don't throw.

`zod/mini` cuts the browser cost by about 18 KB gzipped. It was not chosen because its API style differs from the server's config code, and one style is easier to read across the repo. The switch is confined to `registry.ts` and `frames.ts` if the client's bundle size ever matters more.

## Consequences

- `@aphelion/protocol` gains its first runtime dependency, `zod`. The whole package bundles to 93 KB minified, 26 KB gzipped, almost all of it Zod.
- `z.toJSONSchema` exports `clientFrame` and `serverFrame` as JSON Schema 2020-12, with the command id pattern and `additionalProperties: false` kept.
- The frame types are mapped from the tables, and the two unions are cast to them once in `frames.ts`. The compiler doesn't check that cast. A test parses one sample frame of every type, which catches a field that one side has and the other lacks. It doesn't prove that the two agree on every value. The types are looser in places: `seq` is a `number` in `EventFrame`, which allows 0, while the parser accepts only positive integers. Only `EventLog` builds event frames, and it numbers them from 1.
- An older client rejects an event name that only a newer server knows. Server and clients ship together for now. A version handshake waits until they don't.
- M0-09b still chooses the generator and the format of the spec. Its input is the Zod schemas.
