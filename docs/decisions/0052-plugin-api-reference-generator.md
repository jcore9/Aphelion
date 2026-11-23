# 0052. A test generates the plugin API reference from the SDK's types and doc comments with the TypeScript compiler, and fails when the page is stale

- Status: Proposed
- Date: 2026-11-23
- Proposed by: the plugin API reference PR ([#102](https://github.com/jcore9/Aphelion/issues/102))
- Answers: which generator turns `@aphelion/plugin-sdk` into the published plugin API reference, and how CI catches a stale page

## Context

A plugin author builds against `@aphelion/plugin-sdk`, the package that the plugin dev kit added ([decision 0051](0051-plugin-dev-kit.md)). The M0 plan says the plugin API reference "is generated from the types" ([Keeping it extensible](../plan/milestones/M0-foundations.md#keeping-it-extensible), rule 5). Issue #102 asks for that page on the docs site, a CI check that fails when the page is out of date, and this record.

Some terms used below:

- A **type** is TypeScript's description of a value's shape, such as `{ status: number; body: string }`. The SDK's types are its API.
- A **doc comment**, or TSDoc, is a comment that starts with `/**` and sits right above an exported type or function. Editors show it when a developer hovers over the name. The repository allows no other comments in code, but doc comments that describe a public API are allowed.
- The **TypeScript compiler API** is the part of the `typescript` package that other programs call. It reads the source files and answers questions such as "what does this package export, and what is its type?"
- A **file snapshot** is Vitest's `toMatchFileSnapshot`. A test renders a text and compares it with a committed file. In CI, a difference fails the test. Locally, `-u` rewrites the file.

Two constraints narrow the choice:

- `packages/plugin-sdk/src` ships to plugin authors and may not import `node:` modules ([decision 0023](0023-scaffold-toolchain.md)). The generator has to live somewhere else.
- The docs site takes each page's title from its first line, `# Title`, and the link check refuses relative links to files outside `docs/` ([decision 0033](0033-docs-site-in-place.md)).

The repository already generates two references the same way. The protocol spec is rendered by a test and compared with a file snapshot ([decision 0040](0040-protocol-spec-generator.md)), and so is the config reference.

## Options

### A. A test that reads the SDK with the TypeScript compiler API

A module in `docs/src` asks the compiler for every export of every TypeScript entry in the SDK's `package.json`, with its type and doc comment, and renders one Markdown page. A test compares the page with `docs/reference/plugin-api.md`.

- For: `typescript` 6.0.3 is already a root dev dependency, so nothing new is installed. The page is one file that opens with `# Plugin API reference`, so it fits the site unchanged. The same `test` job and the same `-u` habit as the protocol spec apply. The renderer decides how each kind of export looks, so it can hide private names and Zod internals.
- Against: about 390 lines of collecting and rendering code to own. The renderer handles the declaration kinds the SDK uses today, which are functions, constants, interfaces, type aliases and classes. A new kind fails the test with the export's name until the renderer learns it.

A ten-line test proved first that the compiler API loads under `bun --bun vitest`. It listed the exports of `src/index.ts`, and the whole run took under a second.

### B. TypeDoc with `typedoc-plugin-markdown`

TypeDoc is the common documentation generator for TypeScript, and the plugin makes it write Markdown. It was run on 2026-11-23 in an empty folder outside the repository, with TypeDoc 0.28.20, `typedoc-plugin-markdown` 4.14.1 and TypeScript 6.0.3, on Bun 1.4.5, against the SDK's four entry points. The command was `bun node_modules/.bin/typedoc --plugin typedoc-plugin-markdown --entryPoints src/index.ts src/run-plugin.ts src/stdio.ts src/testing.ts --out out`. The folder was deleted afterwards.

| | Measured |
| --- | --- |
| Runs on Bun | Yes. It accepts TypeScript 6.0 and finished in 1.4 s. |
| Install | 28 packages in the scratch folder, of which 6 were the SDK's own dependencies and TypeScript. `typedoc` is 2.9 MB and the plugin 1.6 MB. |
| Output | 49 Markdown files and 1678 lines, one page per export. |
| Page titles | None of the 49 files opens with `# Title`. Each opens with a breadcrumb link, such as `[**scratch**](../README.md)`, and the H1 comes later. The site would refuse every page. |
| Links | 229 relative links between the generated files, which the site could check once the files are inside `docs/`. |
| Zod schemas | `pluginManifestSchema` is shown as its full Zod type, `ZodObject<{ $schema: ZodOptional<ZodString>; ... }, $strict>`, all on one line. The shape a plugin author gets back is not shown. |
| Private names | `PermissionKind` is shown as ``keyof typeof `permissions` ``, and `PluginManifest` as `ManifestWith<"server"> \| ...`. Neither `permissions` nor `ManifestWith` is on any page. TypeDoc warned about four such names. |

- For: a known tool, with no rendering code to own.
- Against: its pages need a rewrite step for the site's titles, and the Zod and private-name output would need TypeDoc plugins or settings to fix. Fifty pages split the reference where one page fits. The stale check would still need a test or a CI step.

### C. A hand-written table, checked by a test

A person writes the description of each export in a Markdown table, and a test checks that every export has a row.

- For: no rendering code. The prose can say anything.
- Against: the signatures on the page would be typed by hand, and the test can't check that they match the code. Editors don't show the descriptions, because they don't live next to the code. The plan asks for a reference generated from the types.

## Decision

Option A. `docs/src/plugin-api.ts` collects and renders the reference, and `docs/src/plugin-api.test.ts` checks it.

What the collector reads:

- The SDK's `package.json` `exports`. Each TypeScript target is an entry point with its own `##` section, such as `@aphelion/plugin-sdk/testing`. Each JSON target is listed under "Files" with a full GitHub link. Any other target fails the test with its name. A new export or entry point therefore needs no change to the generator.
- The SDK's `tsconfig.json`, so the compiler resolves imports the way the SDK's own type check does.
- For each export, the doc comment on the declaration that defines it, and the doc comments on the members of exported interfaces, classes and object types. `@aphelion/plugin-sdk/runtime` re-exports `runPlugin` from `runtime.ts`, and the collector follows the re-export. `runtime.ts` also exports `serve`, but no entry point does, so `serve` is not on the page.
- The page states the plugin API version from `pluginApiVersion` and links to [the API range](../reference/plugin-manifest.md#the-api-range).

How a signature is rendered. A signature must not use a name that the reader can't find on the page.

- An interface, a class or a type alias is shown as its source text, with comments and function bodies left out.
- A function is shown with the compiler's signature, such as `function main(plugin: ServerPlugin): void;`.
- A constant is shown with its type, such as `const pluginApiVersion: "0.2.1";`.
- A type alias whose source uses a name that the SDK doesn't export is shown as the type the compiler works out instead. `type PermissionKind = keyof typeof permissions` becomes `type PermissionKind = "events" | "secrets" | "network" | "uiSlots";`. An interface or class that uses such a name fails the test, because the compiler can't print it differently.
- A Zod schema constant is shown as `z.ZodType<T>`, where `T` is the value that the schema returns after a successful check. For example, `subscribeParams` becomes `const subscribeParams: z.ZodType<{ event: string }>;`. The page explains `z.ZodType` once, with a link to Zod. The full Zod type was the other choice, and option B shows how unreadable it is. A stub with a hand-written description of the shape was the third choice. It would put the shape in prose that no check keeps true. `pluginManifestSchema` is shown the same way, and its doc comment links to [the plugin manifest reference](../reference/plugin-manifest.md), which explains each field.
- Exports are sorted by name, so the page doesn't change when the order in the source changes.
- The renderer formats the whole page with Prettier, the repository's formatter, so the code blocks on the page have the same layout as the code.

What the test checks:

- The page matches `docs/reference/plugin-api.md`. In CI, a stale page fails the test. Changing one doc comment and running the test without `-u` was checked to fail.
- Every export and every member has a description. A failure lists each one by entry point and name, such as `@aphelion/plugin-sdk/testing TestHost.stop`.
- Every TypeScript entry and every JSON file in `exports` is on the page.
- The version on the page equals `pluginApiVersion`.

`bun --bun vitest run docs/src/plugin-api.test.ts -u` rewrites the page. The path comes before `-u`, because Vitest 5 reads a word after `-u` as the value of `-u` and then runs every test.

## Consequences

- Changing the SDK's public API, or one of its doc comments, now means running the regenerate command and committing the changed page. CI names the page when the author forgets.
- Every new export needs a doc comment, or the test fails. The doc comments are the only source of the page's descriptions, so a reviewer checks them against the code.
- `PluginManifest` is built from private helper types, so the page shows the type the compiler works out. It is correct, but it runs to about 130 lines, because each of its three forms repeats the manifest's fields. Exporting named types for the server-part and client-part forms would shorten it. That changes the SDK's API, which this issue doesn't do. Revisit it with the next change to the manifest types.
- A doc comment that links to a page in `docs/reference/` uses the full GitHub address, so the link works in an editor. The renderer turns it into a relative link on the site, where the link check covers it.
- Revisit TypeDoc if the SDK grows to several packages, or if the reference needs pages per export. Its titles and the Zod output were the deciding problems.
