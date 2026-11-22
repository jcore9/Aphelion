# 0036. The server writes its own JSON logs, with no logging library

- Status: Proposed
- Date: 2026-11-22
- Proposed by: orchestrator, in the M0-08 logging and audit PR ([#10](https://github.com/jcore9/Aphelion/issues/10))
- Answers: the logging library **DR** in the M0 plan's M0-08 design note

## Context

The M0 plan asks M0-08 for structured JSON logs that are redacted by field name and by value pattern, and asks this record to choose the logging library. Redaction means replacing a secret with `[REDACTED]` before the log line is written. "By field name" means any field called `token`, `password` and the like. "By value pattern" means a string that looks like a known kind of secret, such as a GitHub token or a `Bearer` header, wherever it appears.

The logger has to run in the same three places as the store ([decision 0026](0026-sqlite-driver.md)):

- The Bun 1.4.5 runtime.
- Vitest's `threads` pool under `bun --bun vitest run` ([decision 0023](0023-scaffold-toolchain.md)).
- A `bun build --compile` binary with no `node_modules` beside it ([decision 0021](0021-container-init-and-secret-handoff.md)).

M0-14 adds a `Secret` type that must never reach a log. Plugins may hold secrets too, and they import only `plugin-sdk`, never the server. So the redactor needs a way to recognize a secret value without an import from the server.

## Options

This was a one-off measurement on 2026-11-22, with Bun 1.4.5, Vitest 5.1.1 and the package versions in the table header. The comparison script isn't checked in, because it needs all four libraries installed. Each candidate logged the same record. The record holds five secrets: an `authorization` header in a nested object, a `password` inside an array, a GitHub token inside a sentence, an OpenAI-style key in an error message, and a `Bearer` token in that error's cause. It also holds six ordinary values that must survive. Each candidate used the redaction it offers out of the box, configured for these fields. The built-in writer is the one in this PR.

| | Built-in writer | LogTape 2.4.2 with `@logtape/redaction` | pino 10.4.0 | consola 3.4.2 |
| --- | --- | --- | --- | --- |
| Secrets that leaked, Bun 1.4.5 | 0 of 5 | 0 of 5 | 3 of 5 | 3 of 5 |
| Secrets that leaked, Vitest `threads` | 0 of 5 | 0 of 5 | 3 of 5 | 3 of 5, and no output at all until the level is set by hand |
| Secrets that leaked, compiled binary | 0 of 5 | 0 of 5 | 3 of 5 | 3 of 5 |
| Ordinary values lost | 0 of 6 | 0 of 6 | 0 of 6 | 2 of 6: errors log as `{}` |
| Redaction by field name | Our rules, at any depth | A list of regular expressions, at any depth | Fixed paths such as `headers.authorization`. A field at another depth needs another path. | None |
| Redaction by value pattern | Our rules, on each string value | Our rules, on the finished log line | None | None |
| A value that redacts itself | A shared symbol, see below | Only through `toJSON` | Only through `toJSON` | None |
| Async log transport in the compiled binary | Not needed | Not needed | Fails: "Cannot find module `.../thread-stream/lib/worker.js`" | Not needed |
| Runtime dependencies | None | None | 11 packages | None |
| Size added to the compiled binary | 0 | 107 KB | 135 KB | 94 KB |
| Code in this repository | About 210 lines of redactor, 65 lines of logger | About 40 lines of setup and patterns | About 20 lines of setup | A reporter plus our own redactor |

LogTape's default field list matches any field name that contains `token`, `key`, `auth`, `address` or `email`. It would remove `inputTokens`, `cacheKey` and `ipAddress`, which Aphelion needs in its logs, so it would run with our list instead of its own. pino and consola would need our redactor in front of them to pass the test, and then the library adds only the line writer.

## Decision

The built-in writer, in `packages/server/src/log/`. The redactor is the part that matters, and it has to be ours under every option. With LogTape, the library would add log categories and pluggable outputs that M0 doesn't need, plus a second redaction pass over the finished text. With pino and consola, it would add nothing that passes the test. The built-in writer runs in all three places with no dependency.

The rules that follow:

- Code logs through the `Logger` interface from `packages/server/src/log/logger.ts`. It never imports a logging library, so a later move to LogTape changes one file.
- `createLogger` passes every record through `redact` before it writes the line, and adds `time`, `level` and `msg` afterwards. Redaction catches the field names and the secret formats in its rules. It doesn't catch every secret, and [the logging reference](../reference/logging.md#what-redaction-doesnt-catch) lists what it misses.
- The redaction rules are data, in `defaultRules` in `packages/server/src/log/redact.ts`. Adding a rule is a one-line change with a paired test.
- The redactor's output is plain data. It reads each property it uses at most once per visit, so a getter can't return one thing when it is checked and another when it is copied. A test checks this for `toJSON`. A value that throws becomes `[Unreadable]`, and nesting beyond 32 levels becomes `[Too deep]`. The tests show a log call writing one line, without throwing, for each hostile value they cover. The [logging reference](../reference/logging.md#log-format) lists them.
- Each value rule is written so that it doesn't scan the same run of characters again from every position inside it. A string that holds JSON of up to 64 KB is parsed and redacted as data, instead of searched with patterns. A test runs the text rules on 25 hostile strings of about 1 MB and requires each to finish in under 1 second.
- A value that has a method under `Symbol.for("aphelion.redactSelf")` is replaced by what that method returns. `Symbol.for` reads a registry that every module shares, so `plugin-sdk` can define `Secret` without importing the server. M0-14 builds `Secret` on this.
- The audit writer applies the same rules to every text column and to the detail before the insert.

LogTape is the fallback. It is the only library that passed the test, and it has no dependencies.

## Consequences

- M0-14 gives `Secret` a `[Symbol.for("aphelion.redactSelf")]` method and adds its case to `packages/server/src/log/redact.test.ts`.
- M0-10b's device tokens need a fixed prefix, so a value-pattern rule can catch a device token that ends up in a string.
- A secret with no known format, in a field whose name isn't on the list, still reaches the log. The field list and the patterns reduce leaks. They can't prevent every one, so code that handles a secret uses the `Secret` type, whose `redactSelf` method returns a placeholder.
- The logger writes each record as one line to standard output when the call is made. If logging ever shows up as a cost in a profile, revisit this record.
- Revisit when the server needs log categories, several outputs or log shipping. LogTape is the first candidate then.
