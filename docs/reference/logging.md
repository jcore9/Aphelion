# Logging and the audit log

The server keeps two records of what it does. The log is for people who debug the server: one JSON object per line on standard output. The audit log is a table in the SQLite store that says who did what, and what came of it. Code can add rows to the audit log, but it can't change or remove them. [Decision 0036](../decisions/0036-logging-library.md) explains why the server writes its own logs instead of using a library.

Both pass through the same redactor first. It replaces values that match its rules with `[REDACTED]`. The rules catch common secret field names and known secret formats. They can't recognize every secret, so [What redaction doesn't catch](#what-redaction-doesnt-catch) lists the gaps.

## Code

| File | Holds |
| --- | --- |
| `packages/server/src/log/logger.ts` | The `Logger` interface and `createLogger` |
| `packages/server/src/log/redact.ts` | The redaction rules, `redact`, and the `redactSelf` symbol |
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

A log call doesn't throw because of the values it is given, and it always writes a line.

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
| Bytes, such as a `Uint8Array` | `"[N bytes]"`. The bytes are never written. |
| A `bigint` | A string of its digits |
| An object that contains itself | `"[Circular]"` at the point where it repeats |

## Redaction rules

The rules live in `defaultRules` in `packages/server/src/log/redact.ts`. There are two kinds. The output is plain data: objects, arrays, strings, numbers, booleans and `null`.

### By field name

The redactor compares a field name in lower case, with everything except letters and digits removed. So `x-api-key`, `X_API_KEY` and `xApiKey` all become `xapikey`. A field is redacted when that name ends in one of these, in `fieldNameEndings`:

`token`, `password`, `passwd`, `passphrase`, `secret`, `secrets`, `authorization`, `cookie`, `credential`, `credentials`, `apikey`, `accesskey`, `secretkey`, `privatekey`.

It is also redacted when the whole name is one of these, in `exactFieldNames`: `pass`, `pwd`. These two only match whole names, because words such as `bypass` end in them.

So `accessToken`, `ACCESSTOKEN`, `refresh_token`, `x-api-key` and `set-cookie` are redacted. `inputTokens`, `tokenCount`, `secretRef`, `cacheKey` and `bypass` are kept. The whole value is replaced, whatever it is, and the redactor never reads it. The rule applies at any depth, inside arrays, and to the fields of errors.

The same names are matched inside text, in two forms:

| Form | Example | Written as |
| --- | --- | --- |
| `name=value`, as in a URL query or an environment variable | `?access_token=abc&page=2` | `?access_token=[REDACTED]&page=2` |
| A JSON string field inside a string | `{"password":"abc"}` | `{"password":"[REDACTED]"}` |

### By value pattern

Every string is searched for these patterns, in `valueRules`, and each match is replaced. The rest of the string stays. Each rule runs in time proportional to the length of the string, and a test runs each one on a hostile 1 MB string.

| Pattern | Matches |
| --- | --- |
| Bearer or Basic credentials | The credential after `Bearer ` or `Basic `, 8 characters or more |
| Password in a URL | The password in `https://user:password@host` |
| Anthropic API key | `sk-ant-`, a word such as `api03`, `-` and 20 or more characters |
| OpenAI API key | `sk-proj-`, `sk-svcacct-` or `sk-admin-` and 20 or more characters, or `sk-` and 32 or more letters and digits |
| xAI API key | `xai-` and 20 or more letters and digits |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 30 or more characters, or `github_pat_` |
| 1Password service account token | `ops_` and 20 or more characters |
| Slack token | `xoxb-`, `xoxp-` and the other `xox` prefixes |
| AWS access key ID | `AKIA` or `ASIA` and 16 capital letters or digits |
| age secret key | `AGE-SECRET-KEY-1` and 58 characters |
| JSON Web Token | Three dot-separated parts, the first two starting with `eyJ` |
| PEM private key | A whole `-----BEGIN ... PRIVATE KEY-----` block. Without an `-----END` line, everything from `-----BEGIN` to the end of the string. |

The minimum lengths keep ordinary words such as `sk-learn`, `sk-this-is-an-ordinary-slug` and `ghp_short`. A token that is joined to the word before it by a letter, a digit, `_` or `-`, as in `xghp_...`, isn't matched.

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

The redactor works from names and formats. These reach the log unchanged:

- A secret with no known format, in a field whose name isn't on the list. Examples are a password in a field named `value`, or a list of tokens named `tokens`.
- A secret used as a field name, for example an object keyed by token.
- A secret in a `name=value` pair whose value is in quotes, as in `password="abc"`, or a JSON field whose value isn't a string, as in `{"pin": 1234}`.
- A secret that has been encoded, such as base64 of a token, or split across two fields.
- What a `toJSON` or `redactSelf` method returns, beyond the rules above.

Some ordinary text is redacted by mistake. Examples are a word of 8 or more characters after `Bearer` or `Basic`, as in "Basic configuration", and any field whose name ends in `token`, such as `csrfToken`.

Code that handles a secret wraps it in a value that redacts itself, instead of relying on these rules.

## Add a redaction rule

1. Add the field name to `fieldNameEndings` or `exactFieldNames`, or add a value rule to `valueRules`, in `defaultRules` in `packages/server/src/log/redact.ts`. Write a field name in lower case with no separators. Build a value rule with `pattern(name, regex)`, and give the regex the `g` flag, or it replaces only the first match in a string. Start the regex with a one-character lookbehind such as `(?<![\w-])`, so that it can't start again inside a run of the characters it matches. That keeps it from slowing down on long strings.
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
| `action` | Text | What was done, as a dotted name such as `approval.decide` |
| `outcome` | Text | `allowed`, `denied`, `succeeded` or `failed` |
| `agent_id` | Text or empty | The agent the action concerns |
| `session_id` | Text or empty | The agent session the action concerns |
| `request_id` | Text or empty | The request that caused it. The same ID can appear in log lines. |
| `detail` | Text | A JSON object with anything else, after redaction. `{}` when empty. |

`appendAudit` applies the text rules to every text column, and the full redactor to `detail`, before the insert. The table rejects an `id` below 1, an empty `actor_kind`, `action` or `outcome`, and a `detail` that isn't a JSON object. The lists of actor kinds and outcomes are checked by the TypeScript types in `packages/server/src/audit/index.ts`, not by SQLite, so a later milestone can add a value without rebuilding the table.

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
