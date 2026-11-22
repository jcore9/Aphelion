# Secrets

The server holds every secret value, such as an API key or a password, inside a `Secret`. Config files, logs and the database hold only a secret reference, such as `op://AI Agents/GitHub App/private key`, which names where the value lives. [Decision 0044](../decisions/0044-secret-type.md) explains why `Secret` is built the way it is.

Only the server holds `Secret` values. Plugins never see a secret's value ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)), so `Secret` lives in `packages/server`, not in `plugin-sdk`.

## Code

| File | Holds |
| --- | --- |
| `packages/server/src/secrets/secret.ts` | The `Secret` class and its errors |
| `packages/server/src/secrets/reference.ts` | `parseSecretReference` and the reasons it gives |
| `packages/server/src/secrets/canary.test.ts` | The test that a canary value never reaches the logs or the database files |

Server code imports both from `@aphelion/server/secrets`.

## Make, read and wipe a secret

```ts
import { Secret } from "@aphelion/server/secrets";

const token = Secret.make(value, { label: "GitHub token" });
headers.set("authorization", `Bearer ${token.reveal()}`);
token.wipe();
```

- `Secret.make(value, { label })` wraps a value. The label is optional. It shows in place of the value, so it must never contain the value.
- `secret.reveal()` returns the value. It is the only way to read it. Call it where the value is used, such as when you build a request, and pass the `Secret` itself everywhere else. To find every place that reads a secret, search the code for `.reveal(`.
- `secret.wipe()` drops the value. After a wipe, `reveal()` throws `SecretWipedError`, and `secret.wiped` is `true`. Wiping twice does nothing.

## What a `Secret` guarantees

**Printing it never shows the value.** `String(secret)`, a template string, `console.log`, `util.inspect`, `util.format` and an error message all show `<redacted>`. A secret with a label shows `<redacted:GitHub token>`.

**The logger and the audit log write the placeholder.** A `Secret` anywhere in the fields of a log call or in an audit row's `detail` is written as `<redacted>` or `<redacted:label>`. That holds inside nested objects, lists and an error's `cause`. The redactor uses the `Symbol.for("aphelion.redactSelf")` method that [the logging reference](logging.md#values-that-redact-themselves) describes.

**It refuses to be serialized.** Serializing means turning a value into text or bytes, to store it or to send it to another process.

- `JSON.stringify` throws `SecretSerializationError`, even when the `Secret` is deep inside another object. So a `Secret` can't be written into a JSON column or sent as a JSON message.
- `structuredClone`, and the worker and process channels that copy their messages with it, throw a `DataCloneError`.
- The store's `Database` methods accept only text, numbers, bytes and `null` as parameters, so the compiler refuses a `Secret`. If code works around the compiler, SQLite throws `Missing parameter` and writes nothing.

**The value is in a private field.** The class keeps it in `#value`. JavaScript allows no access to a `#` field from outside the class. `Object.keys(secret)` lists only `label` and `reveal`.

**The exact value is masked in every log line.** `Secret.make` registers the value with `maskSecretValue`, as [known secret values](logging.md#known-secret-values) describes. If code reads the value and then puts it into a log line, for example in an error message, the logger still replaces it with `[REDACTED]`. Its base64, URI-encoded and JSON-escaped forms are masked too.

**It fails closed.** If the mask list is full, `maskSecretValue` throws `MaskListFullError`. `Secret.make` lets that error through, and no `Secret` is made. A value that can't be masked can't be used.

**Wiping unmasks the value once nothing else holds it.** `wipe()` calls `unmaskSecretValue`. The mask list counts how many times a value was registered. So when two `Secret`s hold the same value, the value stays masked until both are wiped.

**A canary test checks all of this.** `canary.test.ts` makes a `Secret` from a random value. It logs it in every shape: as a field, nested in objects, lists and a `Map`, as an error's `cause`, and inside an `AggregateError`. It also logs copies of the read value in a message, in a `token` field, in JSON text, in base64, URI-encoded, and in an error message. It writes two audit rows with all of these in `detail` and in the text columns. Then it reads the raw log lines and the raw bytes of every file in the database folder, including the `-wal` file, both while the store is open and after it is closed. The value must not appear anywhere, in plain, base64 or URI-encoded form. A second random value that isn't secret must appear in each of those places, which proves that the search can see what was written.

## What a `Secret` doesn't guarantee

- **Values under 8 characters aren't masked.** `maskSecretValue` ignores them, so that a short common word is never masked. The wrapper is their only protection. Once code calls `reveal()` on such a value, nothing hides the copy it gets back.
- **A value that code has read is ordinary text.** The logger and the audit writer mask it, if it is 8 or more characters. `console.log`, `util.inspect` and other printers don't, because they don't use the redactor. Keep the `Secret` until the last moment, and don't print what `reveal()` returns.
- **Wiping doesn't erase memory.** JavaScript strings can't be overwritten. `wipe()` drops the `Secret`'s reference to the value, and the engine frees the memory later. Copies that code made with `reveal()` stay until they are freed too. After the wipe, those copies are no longer masked in logs.
- **An unwiped value stays masked for the life of the process.** It counts against the mask list's limit of 10,000 values. Code that resolves secrets wipes them when it is done.
- **The label is shown as written.** The label is not a secret. Never put a value, or part of one, in a label.

## Errors

| Error | Thrown by | When |
| --- | --- | --- |
| `MaskListFullError` | `Secret.make` | The mask list already holds 10,000 values. No `Secret` is made. |
| `SecretSerializationError` | `JSON.stringify` | A `Secret` is anywhere in the value being converted. |
| `SecretWipedError` | `secret.reveal()` | The `Secret` was wiped. |
| `DataCloneError` | `structuredClone` | A `Secret` is anywhere in the value being copied. |

## Secret references

A secret reference says where a secret's value lives. It is a scheme, then `://`, then a path. The server checks each reference with `parseSecretReference` where it enters the server, for example when config is loaded. Code past that point uses the parsed result and doesn't check the text again.

```ts
import { parseSecretReference } from "@aphelion/server/secrets";

const result = parseSecretReference("op://AI Agents/GitHub App/private key");
// { ok: true, reference: { scheme: "op", path: "AI Agents/GitHub App/private key" } }
```

On failure the result is `{ ok: false, reason }`. The reason is one of a fixed set of sentences, so it never repeats the text that was given. A reference can come from a file that a stranger wrote, and that text must not reach the logs.

### The schemes

| Scheme | Store | Form | Example |
| --- | --- | --- | --- |
| `op` | 1Password, through its SDK (M0-15) | `op://vault/item/field` or `op://vault/item/section/field` | `op://AI Agents/GitHub App/private key` |
| `bws` | Bitwarden Secrets Manager | `bws://` and the secret's ID | `bws://64246aa4-70b3-4332-8587-8b1284ce6d76` |
| `local` | The server's own encrypted store (M0-14b) | `local://` and one or more names separated by `/` | `local://github/webhook-secret` |

The scheme must be lowercase. Any other scheme is refused.

**`op`** follows 1Password's [secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax/), read on 2026-11-22:

- The path has three or four names: the vault, the item, an optional section, and the field.
- Each name is made of the letters `A` to `Z` and `a` to `z`, the digits, spaces, `-`, `_` and `.`. A name can't start or end with a space. 1Password says to refer to a name with any other character, such as `ü`, by its ID. An ID is 26 letters and digits.
- The reference may end with one of three queries. `?attribute=otp` and `?attribute=totp` ask for the current one-time password code. `?ssh-format=openssh` asks for an SSH private key in the OpenSSH format. Any other query is refused.
- The path is kept exactly as written. 1Password itself ignores case in references.

**`bws`** takes a Bitwarden Secrets Manager secret ID, which is a UUID: 32 hexadecimal digits in groups of 8, 4, 4, 4 and 12, separated by `-`. Uppercase digits are accepted and stored in lowercase.

**`local`** takes one or more names separated by `/`. Each name starts with a lowercase letter or a digit, and then holds lowercase letters, digits, `.`, `-` and `_`. So `.` and `..` can't be names, and no name is empty.

### Reasons

| Cause | Reason |
| --- | --- |
| Not text, or longer than 1024 characters | `must be text of at most 1024 characters` |
| No scheme, or a scheme other than the three | `must start with op://, bws:// or local://` |
| A bad `op` path | `must be op://vault/item/field or op://vault/item/section/field, each name made of letters, digits, spaces, hyphens, underscores and dots` |
| A query other than the three | `may end only with ?attribute=otp, ?attribute=totp or ?ssh-format=openssh` |
| A bad `bws` ID | `must be bws:// and a Bitwarden secret ID, such as bws://64246aa4-70b3-4332-8587-8b1284ce6d76` |
| A bad `local` name | `must be local:// and names made of lowercase letters, digits, dots, hyphens and underscores, separated by /, such as local://github/webhook-secret` |

The plugin manifest checks `permissions.secrets` with a looser rule, which only requires a scheme, `://` and visible characters ([plugin manifest](plugin-manifest.md)). The server's parser is the one that decides. For example, the manifest accepts `op://AI Agents/Wetter Zürich/credential`, and `parseSecretReference` refuses it, because `ü` must be written as the item's ID.
