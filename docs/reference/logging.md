# Logging and the audit log

The server keeps two records of what it does. The log is for people who debug the server: one JSON object per line on standard output. The audit log is a table in the SQLite store that says who did what, and what came of it. Code can add rows to the audit log, but it can't change or remove them. [Decision 0036](../decisions/0036-logging-library.md) explains why the server writes its own logs instead of using a library.

## How secrets are kept out

The owner decided on 2026-11-22 to rely on structure, not on searching free text. There are three layers, and a fourth that is only a backup:

1. **The `Secret` type.** M0-14 adds a wrapper that holds a secret and always hides itself when it is logged. Code that handles a secret keeps it in this wrapper. [Values that redact themselves](#values-that-redact-themselves) explains the hook it uses.
2. **Fixed messages and named fields.** Every log message is fixed text, written in the code, and the same holds for the audit `action`. The compiler refuses anything else. Data goes only in named fields, and a field whose name says it holds a secret, such as `password` or `token`, is hidden whatever its value is. [Fixed messages](#fixed-messages) explains the rule.
3. **Masking known secret values.** When the server learns a secret's exact value, it registers it with `maskSecretValue`. From then on, every occurrence of that exact text is replaced with `[REDACTED]`. [Known secret values](#known-secret-values) explains it.
4. **Pattern scanning, as a backup.** The redactor also searches text for known token formats, such as GitHub tokens and `Bearer` headers. It can't recognize every secret. [What redaction doesn't catch](#what-redaction-doesnt-catch) lists its known gaps, and they are listed rather than chased.

Established tools work the same way. Checked on 2026-11-22:

- GitHub Actions masks a secret by registering its exact value with `::add-mask::` ([workflow commands](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands)).
- pino hides fixed field paths, not patterns ([pino 10.4.0 redaction](https://unpkg.com/pino@10.4.0/docs/redaction.md)).
- Effect wraps secrets in a `Redacted` type that hides itself ([Effect `Redacted`](https://effect.website/docs/data-types/redacted/)).
- T3 Code 0.1.12, inspected in its bundled code, uses Effect's `Redacted`, hides HTTP headers and URL parameters by name, uses one pattern for URL credentials, and replaces a token it knows by its exact value. It keeps no broad list of token patterns.
- OWASP ASVS chapter V7 requires that logs hold no secrets ([V7: Error Handling and Logging](https://github.com/OWASP/ASVS/blob/master/4.0/en/0x15-V7-Error-Logging.md)).

Both the log and the audit log pass through the same redactor.

## Code

| File | Holds |
| --- | --- |
| `packages/server/src/log/logger.ts` | The `Logger` interface and `createLogger` |
| `packages/server/src/log/redact.ts` | The redaction rules, `redact`, and the `redactSelf` symbol |
| `packages/server/src/log/masks.ts` | `maskSecretValue` and the list of known secret values |
| `packages/server/src/audit/index.ts` | The audit entry type and `appendAudit` |
| `packages/server/src/store/migrations/0001-audit-log.ts` | The `audit_log` table and its triggers |

## Log format

Each call writes one line. A line is a JSON object with `time`, `level` and `msg` first, then the fields that the caller passed:

```json
{"time":"2026-11-22T10:00:00.000Z","level":"info","msg":"agent started","agentId":"triage","attempt":2}
```

| Field | Holds |
| --- | --- |
| `time` | When the record was made, in UTC, as ISO 8601 with milliseconds |
| `level` | `debug`, `info`, `warn` or `error` |
| `msg` | The message |
| Any other | The fields from the call, after redaction |

The logger redacts the fields first and adds `time`, `level` and `msg` afterwards, so a field can't replace them. A field named `time`, `level` or `msg` is dropped. If the fields object turns into something other than an object, for example because it has its own `toJSON`, the result is written under `fields`.

The tests cover getters, `toJSON` methods and `redactSelf` methods that throw, a proxy that throws, nesting 10,000 levels deep, and a message that isn't a string. In each case the call writes one line and doesn't throw. A `write` function that throws still makes the call throw.

### Fixed messages

A log message is fixed text: a string written directly in the code, such as `"agent started"`. Anything that changes from call to call, such as a user name or an error, goes in a named field instead.

```ts
log.info("agent started", { agentId }); // compiles
log.info(`agent ${agentId} started`); // fails typecheck
log.info(message); // fails typecheck when message is a string variable
```

This is why the rule exists. A field has a name, and the redactor hides a field by its name, such as `password` or `token`, whatever is in it. Text built into the message has no name, so only pattern scanning could find a secret in it, and pattern scanning misses secrets it doesn't recognize. Keeping messages fixed means every piece of data reaches the log under a name.

The compiler enforces the rule. The type `FixedText` accepts a string written in the code, a choice between such strings, and a template made only of constants. It rejects a variable of type `string`, a template with a value in it, and a choice in which any branch is one of those. `bun run typecheck` fails on a call that breaks the rule. The tests in `packages/server/src/log/logger.test.ts` and `packages/server/src/audit/audit.test.ts` prove each rejected form with `@ts-expect-error` lines.

At run time, the message is still redacted as a backup. A string is redacted like any other string. A number or a boolean is written as text. Any other message, such as a `bigint`, bytes or an object, is written as `[Unreadable]`.

```ts
import { createLogger } from "@aphelion/server/log";

const log = createLogger({ level: "info" });
log.info("agent started", { agentId: "triage" });
log.error("push failed", { error });
```

`createLogger` takes these options, and every one is optional:

| Option | Default | Does |
| --- | --- | --- |
| `level` | `info` | Drops records below this level |
| `write` | Writes the line to standard output | Receives each finished line. Tests pass a function that collects the lines. |
| `now` | The current time | Gives the record's `time` |
| `rules` | `defaultRules` | The redaction rules |

How the redactor writes other values:

| Value | Written as |
| --- | --- |
| An `Error` | An object with `name`, `message`, `stack`, `cause`, and the error's own fields. An `AggregateError` adds `errors`. Each part is redacted. |
| An object with `toJSON`, such as a `Date` or a `URL` | What `toJSON` returns, redacted. The redactor reads `toJSON` once and calls it once. |
| A function or a symbol | Left out |
| A value that throws when it is read, converted or redacted | `"[Unreadable]"` |
| An object nested more than 32 levels deep | `"[Too deep]"` at level 32 |
| Bytes, such as a `Uint8Array` | `"[N bytes]"`, or `"[bytes]"` if its `byteLength` isn't a whole number. The bytes are never written. |
| A `bigint` | A string of its digits |
| An object that contains itself | `"[Circular]"` at the point where it repeats |

## Redaction rules

The rules live in `defaultRules` in `packages/server/src/log/redact.ts`. There are two kinds. The output is plain data: objects, arrays, strings, numbers, booleans and `null`.

### By field name

The redactor compares a field name in lower case, with everything except letters and digits removed. So `x-api-key`, `X_API_KEY` and `xApiKey` all become `xapikey`. A field is redacted when that name ends in one of these, in `fieldNameEndings`:

`token`, `password`, `passwd`, `passphrase`, `secret`, `secrets`, `authorization`, `cookie`, `credential`, `credentials`, `apikey`, `accesskey`, `secretkey`, `privatekey`.

It is also redacted when the whole name is one of these, in `exactFieldNames`: `pass`, `pwd`. These two only match whole names, because words such as `bypass` end in them.

So `accessToken`, `ACCESSTOKEN`, `refresh_token`, `x-api-key` and `set-cookie` are redacted. `inputTokens`, `tokenCount`, `secretRef`, `cacheKey` and `bypass` are kept. The whole value is replaced, whatever it is, and the redactor never reads it. The rule applies at any depth, inside arrays, and to the fields of errors.

### Known secret values

`maskSecretValue(value)` registers a secret's exact value. From then on, every string that the redactor sees has each registered value replaced with `[REDACTED]`. That covers messages, field values, error messages and stack traces, JSON inside strings, and every audit text column.

- Values shorter than 8 characters (`minimumMaskLength`) are ignored, so that a short common word is never masked.
- When registered values contain or overlap each other, the whole run they cover becomes one `[REDACTED]`.
- The list lives only in the server's memory. It is never written anywhere, and nothing can read it back.
- M0-14's `Secret` type calls `maskSecretValue` when a secret is resolved.

A test registers 1,000 values and checks a 1 MB line in under 1 second. On the development machine on 2026-11-22, it took about 100 ms.

### JSON inside a string

JSON inside a string is parsed, not searched. The redactor scans the string once for each top-level `{...}` or `[...]` segment whose brackets balance, and skips brackets inside quoted JSON strings. It parses each segment by itself with `JSON.parse`.

- A segment can be at most 64 KB long (`jsonParseLimit`), counted in UTF-16 code units, which is what JavaScript's `length` counts. A longer segment goes to the text rules.
- The redactor parses at most the first 16 segments in a string (`jsonSegmentLimit`). The rest go to the text rules.
- If redacting the parsed segment changes nothing, the segment stays exactly as it was, byte for byte, and only the text rules run on it.
- If something in it was redacted, the segment is written back with `JSON.stringify`. The original spacing is lost, escapes such as `\u0077` come back as the characters they stand for, and numbers are rewritten too. For example, `9007199254740993` becomes `9007199254740992` and `1e400` becomes `null`.

So `received {"password":1234} then {"status":"done"}` becomes `received {"password":"[REDACTED]"} then {"status":"done"}`. JSON encoded inside a JSON string is handled the same way. Text between the segments, and segments that don't parse, go to the text rules below.

### Names inside text

The text rules match the same field names in these forms:

| Form | Example | Written as |
| --- | --- | --- |
| A URL query parameter, after `?` or `&` | `?access_token=a,b;c'd&page=2` | `?access_token=[REDACTED]&page=2`. The value ends at `&`, `#`, whitespace, `"` or the end of the string. `'` and a backtick are legal in a URL, so they don't end it. |
| `name=value` elsewhere, as in an environment variable | `GITHUB_TOKEN=abc PORT=8080` | `GITHUB_TOKEN=[REDACTED] PORT=8080`. The value ends at whitespace, `&`, `#`, `"`, `'`, a backtick, `,` or `;`. |
| A JSON string field in text that doesn't parse | `{"password":"abc",` | `{"password":"[REDACTED]",`. Escapes in the name, such as `\u0077`, are decoded before the name is compared. Names up to 1,024 characters are checked. If the value has no closing quote, it is masked to the end of the string. |

The redactor runs the value patterns below first, and these name rules after them. A test puts each rule's target next to every other rule's target, separated by `"`, `'`, a backtick, `","`, `", "` or a space, and checks that both stay masked.

### By value pattern

Every string is searched for these patterns, in `valueRules`, and each match is replaced. The rest of the string stays. Each rule is written so that it doesn't scan the same run of characters again from every position inside it. A test runs the text rules on 29 hostile strings of about 1 MB, 9 of them shaped like JSON, and requires each to finish in under 1 second. On the development machine on 2026-11-22, each took under 100 ms.

| Pattern | Matches |
| --- | --- |
| Bearer or Basic credentials | The credential after `Bearer ` or `Basic `, 8 characters or more |
| Password in a URL | The password in `https://user:password@host`. The user name and the password end at `"`, whitespace, `/` or `@`. `'` and a backtick are legal in a URL, so they don't end them. |
| Anthropic API key | `sk-ant-`, a word such as `api03`, `-` and 20 or more characters |
| OpenAI API key | `sk-proj-`, `sk-svcacct-` or `sk-admin-` and 20 or more characters, or `sk-` and 32 or more letters and digits |
| xAI API key | `xai-` and 20 or more letters and digits |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 30 or more characters, or `github_pat_` |
| 1Password service account token | `ops_` and 20 or more characters |
| Slack token | `xoxb-`, `xoxp-` and the other `xox` prefixes |
| AWS access key ID | `AKIA` or `ASIA` and 16 capital letters or digits |
| age secret key | `AGE-SECRET-KEY-1` and 58 characters |
| JSON Web Token | Three dot-separated parts, the first two starting with `eyJ` |
| PEM private key | A whole `-----BEGIN ... PRIVATE KEY-----` block. Without an `-----END` line before the next `"`, `'` or backtick, everything from `-----BEGIN` up to that quote or the end of the string. |

The minimum lengths keep ordinary words such as `sk-learn`, `sk-this-is-an-ordinary-slug` and `ghp_short`. A token is matched when the character in front of it isn't a letter, a digit or `_`. So `key-ghp_...`, `key.ghp_...`, `/ghp_...`, `=ghp_...` and `"ghp_..."` are masked, and `xghp_...` isn't. A test checks each token type in 15 positions, including inside a URL and in a `name=value` pair.

### Values that redact themselves

An object that has a method under `Symbol.for("aphelion.redactSelf")` is replaced by what that method returns. The method must return a placeholder string, such as `"[secret op://vault/item]"`, and never the value itself. The redactor applies the rules to whatever the method returns, but a secret with no known format passes through unchanged. The server exports the symbol as `redactSelf`. Code outside the server, such as `plugin-sdk`, reaches the same symbol with `Symbol.for("aphelion.redactSelf")`, with no import. M0-14's `Secret` type uses this method.

```ts
class Secret {
	[Symbol.for("aphelion.redactSelf")]() {
		return "[secret op://vault/item]";
	}
}
```

### What redaction doesn't catch

These gaps are known and accepted. The first three layers, not more patterns, are the answer to them. These reach the log unchanged, unless the value was registered with `maskSecretValue`:

- A secret with no known format, in a field whose name isn't on the list. Examples are a password in a field named `value`, or a list of tokens named `tokens`.
- A secret used as a field name, for example an object keyed by token.
- A secret in a `name=value` pair whose value is in quotes, as in `password="abc"`.
- In JSON that doesn't parse, is over 64 KB, or comes after the 16th segment: a field whose value isn't a string, as in `{"password": 1234}`, or whose name is longer than 1,024 characters or contains an escaped quote `\"`.
- A secret in a message built at run time, if the compiler check was bypassed with a type cast.
- Two JSON Web Tokens joined by `-`. The second one isn't matched.
- A secret that has been encoded, such as base64 of a token, or split across two fields.
- What a `toJSON` or `redactSelf` method returns, beyond the rules above.

Some ordinary text is redacted by mistake. Examples are a word of 8 or more characters after `Bearer` or `Basic`, as in "Basic configuration", and any field whose name ends in `token`, such as `csrfToken`.

Code that handles a secret wraps it in the `Secret` type, instead of relying on these rules.

## Add a redaction rule

1. Add the field name to `fieldNameEndings` or `exactFieldNames`, or add a value rule to `valueRules`, in `defaultRules` in `packages/server/src/log/redact.ts`. Write a field name in lower case with no separators. Build a value rule with `pattern(name, regex)`, and give the regex the `g` flag, or it replaces only the first match in a string. Start a token pattern with the one-character lookbehind `(?<![A-Za-z0-9_])`, and don't put anything after an unbounded part such as `[\w-]{20,}`. A pattern that can fail after a long scan, and start again inside the same run, slows down on long strings. A name rule stops at `"`, and outside URLs at `'` and a backtick too.
2. Add a case to `byFieldName` or `byValuePattern` in `packages/server/src/log/redact.test.ts`. Set `secret` to the part that must disappear, and set `kept` to a similar ordinary value that must stay. For a value rule, add a long hostile string to `large hostile strings` in the same file.
3. Add the rule to the lists on this page.
4. Run `bun run test`.

## The audit log

The `audit_log` table in the SQLite store holds one row per audited action. M2's policy engine writes approvals here. [The store reference](store.md) explains the store and its migrations.

| Column | Type | Holds |
| --- | --- | --- |
| `id` | Integer | The row number. Each new row gets a larger one. |
| `at` | Text | When the row was written, in UTC, as ISO 8601 with milliseconds. SQLite fills it in. |
| `actor_kind` | Text | Who acted: `server`, `cli`, `device`, `agent` or `plugin` |
| `actor_id` | Text or empty | Which device, agent or plugin. Empty for `server` and `cli`. |
| `action` | Text | What was done, as a dotted name such as `approval.decide`. It must be fixed text in the code, like a log message. |
| `outcome` | Text | `allowed`, `denied`, `succeeded` or `failed` |
| `agent_id` | Text or empty | The agent the action concerns |
| `session_id` | Text or empty | The agent session the action concerns |
| `request_id` | Text or empty | The request that caused it. The same ID can appear in log lines. |
| `detail` | Text | A JSON object with anything else, after redaction. `{}` when empty. |

`appendAudit` applies the text rules to every text column, and the full redactor to `detail`, before the insert. If the redacted `detail` isn't an object, for example because it couldn't be read, the row is stored with the detail `{"unreadable":true}`, so the write still succeeds. The table rejects an `id` below 1, an empty `actor_kind`, `action` or `outcome`, and a `detail` that isn't a JSON object. The lists of actor kinds and outcomes are checked by the TypeScript types in `packages/server/src/audit/index.ts`, not by SQLite, so a later milestone can add a value without rebuilding the table.

Write a row with `appendAudit`, which returns the new row's `id`:

```ts
import { appendAudit } from "../audit";

appendAudit(db, {
	actor: { kind: "device", id: "laptop" },
	action: "approval.decide",
	outcome: "allowed",
	agentId: "triage",
	detail: { tool: "git push" },
});
```

### Append-only

Three SQLite triggers stop any change to a row once it is written. A trigger is a rule that SQLite runs before each matching statement. Each of these aborts the statement with the error `audit_log is append-only`.

| Trigger | Rejects |
| --- | --- |
| `audit_log_no_update` | `UPDATE`, including the update part of `INSERT ... ON CONFLICT DO UPDATE` |
| `audit_log_no_delete` | `DELETE` |
| `audit_log_no_replace` | `INSERT OR REPLACE` or `REPLACE` with the `id` of an existing row. SQLite replaces such a row without running delete triggers, so the delete trigger alone doesn't catch it. The trigger checks only ids above 0, because SQLite shows an id that it hasn't assigned yet as `-1`. |

The triggers protect the table from mistakes in the server's own code. They don't protect it from a process that can write to the database file, because such a process can drop the triggers. Agents can't reach the database file ([decision 0014](../decisions/0014-filesystem-layout.md)).
