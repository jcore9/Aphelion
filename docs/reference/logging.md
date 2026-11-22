# Logging and the audit log

The server keeps two records of what it does. The log is for people who debug the server: one JSON object per line on standard output. The audit log is a table in the SQLite store that says who did what, and what came of it. Code can add rows to the audit log, but it can't change or remove them. [Decision 0036](../decisions/0036-logging-library.md) explains why the server writes its own logs instead of using a library.

Both pass through the same redactor first. It replaces anything that looks like a secret with `[REDACTED]`.

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

A field named `time`, `level` or `msg` doesn't replace the record's own value.

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
| An object with `toJSON`, such as a `Date` or a `URL` | What `toJSON` returns, redacted |
| Bytes, such as a `Uint8Array` | `"[N bytes]"`. The bytes are never written. |
| A `bigint` | A string of its digits |
| An object that contains itself | `"[Circular]"` at the point where it repeats |

## Redaction rules

The rules live in `defaultRules` in `packages/server/src/log/redact.ts`. There are two kinds.

### By field name

A field whose name ends in one of these words has its whole value replaced, whatever the value is:

`token`, `password`, `passwd`, `passphrase`, `secret`, `secrets`, `authorization`, `cookie`, `credential`, `credentials`, `api key`, `apikey`, `access key`, `secret key`, `private key`.

The redactor splits a field name into words at capital letters, `_`, `-` and other punctuation, then compares the last words. So `accessToken`, `refresh_token`, `x-api-key` and `set-cookie` are redacted. `inputTokens`, `tokenCount`, `secretRef` and `cacheKey` are kept, because their last word isn't on the list. The rule applies at any depth, inside arrays, and to the fields of errors.

### By value pattern

Every string is searched for these patterns, and each match is replaced. The rest of the string stays.

| Pattern | Matches |
| --- | --- |
| Bearer or Basic credentials | The credential after `Bearer ` or `Basic `, 8 characters or more |
| Password in a URL | The password in `https://user:password@host` |
| Anthropic or OpenAI API key | `sk-` and 20 or more characters |
| xAI API key | `xai-` and 20 or more letters and digits |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` and 30 or more characters, or `github_pat_` |
| 1Password service account token | `ops_` and 20 or more characters |
| Slack token | `xoxb-`, `xoxp-` and the other `xox` prefixes |
| AWS access key ID | `AKIA` or `ASIA` and 16 capital letters or digits |
| age secret key | `AGE-SECRET-KEY-1` and 58 characters |
| JSON Web Token | Three dot-separated parts, the first two starting with `eyJ` |
| PEM private key | A whole `-----BEGIN ... PRIVATE KEY-----` block |

The minimum lengths keep ordinary words such as `sk-learn` and `ghp_short`.

### Values that redact themselves

An object that has a method under `Symbol.for("aphelion.redactSelf")` is replaced by what that method returns. The server exports the symbol as `redactSelf`. Code outside the server, such as `plugin-sdk`, reaches the same symbol with `Symbol.for("aphelion.redactSelf")`, with no import. M0-14's `Secret` type uses this method.

```ts
class Secret {
	[Symbol.for("aphelion.redactSelf")]() {
		return "[secret op://vault/item]";
	}
}
```

### What redaction doesn't catch

A secret with no known prefix, in a field whose name isn't on the list, reaches the log unchanged. Field names that hold secrets aren't redacted either, for example when an object is keyed by token. Code that handles a secret wraps it in a value that redacts itself.

## Add a redaction rule

1. Add the field name or the pattern to `defaultRules` in `packages/server/src/log/redact.ts`. Give a pattern the `g` flag, or it replaces only the first match in a string.
2. Add a case to `byFieldName` or `byValuePattern` in `packages/server/src/log/redact.test.ts`. Set `secret` to the part that must disappear, and set `kept` to a similar ordinary value that must stay.
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

The table rejects an empty `actor_kind`, `action` or `outcome`, and a `detail` that isn't a JSON object. The lists of actor kinds and outcomes are checked by the TypeScript types in `packages/server/src/audit/index.ts`, not by SQLite, so a later milestone can add a value without rebuilding the table.

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
| `audit_log_no_replace` | `INSERT OR REPLACE` or `REPLACE` with the `id` of an existing row. SQLite replaces such a row without running delete triggers, so the delete trigger alone doesn't catch it. |

The triggers protect the table from mistakes in the server's own code. They don't protect it from a process that can write to the database file, because such a process can drop the triggers. Agents can't reach the database file ([decision 0014](../decisions/0014-filesystem-layout.md)).
