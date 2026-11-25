# Secrets

The server and the secrets broker hold secret values, such as an API key or a password, inside a `Secret`. Config files, logs and the database hold only a secret reference, such as `op://AI Agents/GitHub App/private key`, which names where the value lives. [Decision 0044](../decisions/0044-secret-type.md) explains why `Secret` is built the way it is.

Plugins never see a secret's value ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)), so `Secret` lives in `apps/server`, not in `plugin-sdk`.

## Local secrets broker

The broker runs as a separate Linux process under `aphelion-secrets` (user ID 10003). Build its executable with `bun run --filter @aphelion/server build:broker`. The executable is `apps/server/dist/aphelion-secrets`. In the container, the [launcher](container.md#how-the-processes-start) starts it.

### The bootstrap key

The store's key is an age identity, the private half of a key pair for [age](https://age-encryption.org), a small file encryption format. It is a line that starts with `AGE-SECRET-KEY-1`. It is the bootstrap key, and only the host keeps it ([decision 0050](../decisions/0050-bootstrap-key-is-the-store-key.md)). It travels this way:

1. `deploy/host/install` makes the key once and seals it with `systemd-creds` in `/etc/credstore.encrypted/aphelion-bootstrap`.
2. At each start, `aphelion.service` decrypts it with `LoadCredentialEncrypted=` into `/run/credentials/aphelion.service/bootstrap`. That folder is in memory and readable only by root.
3. Compose mounts the file at `/run/secrets/bootstrap` in the container.
4. The launcher opens the file as root and gives it to the broker as standard input.
5. The broker reads at most 1 KiB from standard input, the channel the launcher feeds it. It trims spaces and line breaks from both ends, and closes that channel. The broker then no longer holds the file.

The broker wraps the key in a `Secret`, so the logger masks it. The key never reaches an environment variable, a command line or the volume.

`aphelion-secrets --new-key` prints a new age identity and a line break, and exits. It runs as any user. The host install uses it. Any other argument is refused.

| Path | Owner and mode | Purpose |
| --- | --- | --- |
| `/run/aphelion-secrets/` | `aphelion-secrets:harness`, `2710` | Gives members of the private `harness` group permission to reach the socket. The set-group-ID bit makes the socket inherit that group. |
| `/run/aphelion-secrets/broker.sock` | `aphelion-secrets:harness`, `0660` | The broker creates the socket at startup. The service accounts for bots and plugins are outside the `harness` group. |
| `/var/lib/aphelion-secrets/` | `aphelion-secrets`, `0700` | The persistent store. It holds no private key. |
| `/var/lib/aphelion-secrets/<64 hex digits>.age` | `aphelion-secrets`, `0600` | One encrypted entry per local reference. |
| `/var/lib/aphelion-secrets/recipient.pub` | `aphelion-secrets`, `0600` | The store's public key, which starts with `age1`. It isn't secret. The broker writes it on the first start. |

The parent folders of these paths must be writable only by root. In the container, `/run/aphelion-secrets/` is a fresh in-memory folder. Docker creates it with this owner and mode at every start, so no socket is left over from an earlier run. The launcher checks its owner and mode before it starts the broker. The broker checks the socket directory group against the local `harness` group in `/etc/group`. It refuses to replace an existing socket at startup.

The store keeps an age-encrypted file per local reference. The filename is the SHA-256 hash of the reference path. The broker writes encrypted data to a private temporary file and then renames it into place. The encrypted record includes a format version and the reference path. A read fails if the stored path differs from the requested path.

`recipient.pub` catches a wrong key. It isn't protection against someone who can change files in the volume. If `recipient.pub` is missing, the broker checks every entry before it writes the file. Each one must decrypt with the key and hold the reference path that its filename was made from.

To back up the store, copy the entry files and `recipient.pub`. The folder holds no key, so a copy of it alone decrypts nothing. Keep the [recovery copy of the key](../guides/install.md#keep-a-recovery-copy-of-the-bootstrap-key) apart from the backup.

### Startup refusals

At startup the broker checks the key against the store. When a check fails, the broker exits with code 1 and logs `Secrets broker startup failed` with one of these fixed reasons. The reason never contains the key.

| Reason | When |
| --- | --- |
| `The bootstrap key is missing from standard input` | Standard input was empty, or held only spaces and line breaks. |
| `The bootstrap key is longer than 1 KiB` | Standard input held more than 1024 bytes. |
| `The bootstrap key is not a valid age identity` | The key isn't an age identity. |
| `The secrets store holds a plain-text key from before the host credential` | `identity.agekey` is still in the store. [Start a fresh store after an older install](../guides/install.md#start-a-fresh-store-after-an-older-install) explains what to do. |
| `The bootstrap key does not match this secrets store` | `recipient.pub` holds another public key. Or `recipient.pub` is missing, and an entry doesn't decrypt with the key or doesn't match its filename. |
| `The secrets broker takes no arguments except --new-key` | The broker was started with another argument. |

If `recipient.pub` is missing and entries exist, as after restoring a backup of only the entries, the broker checks every entry first, as described above. Then it writes `recipient.pub`. Other startup failures, such as a folder with the wrong owner or mode, log `Secrets broker startup failed` with no reason.

### Socket protocol

The socket accepts HTTP `POST /v1/local` with a UTF-8 JSON body of at most 64 KiB. A request has an `op` and a `ref`. A write also has a string `value`. All references must use `local://`.

| Operation | Example body | Success response |
| --- | --- | --- |
| Write | `{"op":"write","ref":"local://github/webhook-secret","value":"example"}` | `204`, empty body |
| Read | `{"op":"read","ref":"local://github/webhook-secret"}` | `200`, the value as a JSON string |

An invalid request returns `400`. An unknown endpoint or missing entry returns `404`. A broker error returns `500` with an empty body. A request that exceeds the size limit closes the connection. Error logs contain fixed messages. The plaintext value crosses the socket only when the harness writes or reads it.

The Linux contract test builds the executable, runs it as `aphelion-secrets` in Docker, and connects as each service account. It feeds the broker a key from `--new-key` on standard input, as the launcher does. It checks that `harness` reads a value after restart and that `aphelion-bot` and `aphelion-plugins` get a permission error from Linux. The store must hold `recipient.pub` and no `identity.agekey`. The broker must refuse an empty standard input and another key, each with its reason. The test also scans the broker logs and store files for the test value and for both keys.

## Code

| File | Holds |
| --- | --- |
| `apps/server/src/secrets/secret.ts` | The `Secret` class and its errors |
| `apps/server/src/secrets/reference.ts` | `parseSecretReference` and the reasons it gives |
| `apps/server/src/secrets/local-store.ts` | The local encrypted store and its startup refusals |
| `apps/server/src/secrets/broker-main.ts` | The broker process: `--new-key`, reading the key, and the socket |
| `apps/server/src/secrets/canary.test.ts` | The test that a canary value never reaches the logs or the database files |

Server code imports `Secret` and `parseSecretReference` from `@aphelion/server/secrets`.

## Make, read and wipe a secret

```ts
import { Secret } from "@aphelion/server/secrets";

const token = Secret.make(value, { label: "GitHub token" });
headers.set("authorization", `Bearer ${token.reveal()}`);
token.wipe();
```

- `Secret.make(value, { label })` wraps a value. It is the only way to make a `Secret`. The label is optional. It shows in place of the value, so it must never contain the value.
- `secret.reveal()` returns the value. It is the only way to read it. Call it where the value is used, such as when you build a request, and pass the `Secret` itself everywhere else. To find every place that reads a secret, search the code for `.reveal(`.
- `secret.wipe()` drops the value. After a wipe, `reveal()` throws `SecretWipedError`, and `secret.wiped` is `true`. Wiping twice does nothing.

## What a `Secret` guarantees

**Only `Secret.make` can make one.** `new Secret(...)` and a subclass throw `SecretConstructionError`, at run time as well as in the compiler. The constructor checks for a token that only `Secret.make` holds. So every `Secret` has gone through masking, and only such a `Secret` can unmask a value when it is wiped. Calling `wipe()` on any other object throws a `TypeError` and unmasks nothing.

**Turning it into text gives the placeholder.** These all give `<redacted>`, or `<redacted:GitHub token>` for a secret with a label:

- `String(secret)`, a template string, `+` with a string, and `[secret].join()`.
- `console.log`, `util.inspect` and `util.format` with `%s`, `%o` or `%O`.
- An error message built from it, and an error whose `cause` is the `Secret`, when it is printed.
- `new Blob([secret])` and `Bun.write(path, secret)`. Both convert the `Secret` to text first. The `Bun.write` case was checked by hand with Bun 1.4.5, because the tests can't call Bun's own APIs outside `adapters/`.

**The logger and the audit log write the placeholder.** The placeholder is `<redacted>`, or `<redacted:label>` for a secret with a label. It replaces a `Secret` anywhere in the fields of a log call or in an audit row's `detail`. That holds inside nested objects, lists and an error's `cause`. The redactor uses the `Symbol.for("aphelion.redactSelf")` method that [the logging reference](logging.md#values-that-redact-themselves) describes.

**Serializing it throws.** Serializing here means converting a value, with everything inside it, into JSON or into a copy for another thread or process. These throw, even when the `Secret` is deep inside another object:

- `JSON.stringify` throws `SecretSerializationError`. So a `Secret` can't be written into a JSON column or sent as a JSON message.
- `structuredClone` and `MessagePort.postMessage` throw a `DataCloneError`. A `Secret` holds a symbol in its `cloneGuard` property, and the structured clone algorithm refuses symbols. Any channel that copies messages with that algorithm refuses a `Secret` the same way.
- The store's `Database` methods accept only text, numbers, bytes and `null` as parameters, so the compiler refuses a `Secret`. If code works around the compiler, SQLite throws `Missing parameter` and writes nothing.

**Copying its properties copies nothing useful.** A spread, such as `{ ...secret }`, and `Object.assign` copy only the `label` and `cloneGuard` properties. Neither is a function, so the copy can't read the value.

**The value is in a private field, and the object can't be changed.** The class keeps the value in `#value`. JavaScript allows no access to a `#` field from outside the class. `Object.keys(secret)` lists only `label` and `cloneGuard`. Each `Secret`, the class and its methods are frozen, so code can't delete `cloneGuard` or replace `reveal`, `toString` or `toJSON`.

**The exact value is masked in every log line.** `Secret.make` registers the value with `maskSecretValue`, as [known secret values](logging.md#known-secret-values) describes. If code reads the value and then puts it into a log line, the logger still replaces it with `[REDACTED]`. An example is a value in an error message. The base64, URI-encoded and JSON-escaped forms of the value are masked too.

**It fails closed.** If the mask list is full, `maskSecretValue` throws `MaskListFullError`. `Secret.make` lets that error through, and no `Secret` is made. A value that can't be masked can't be used.

**Wiping unmasks the value once nothing else holds it.** `wipe()` calls `unmaskSecretValue`. The mask list counts how many times a value was registered. So when two `Secret`s hold the same value, the value stays masked until both are wiped.

**A canary test checks all of this.** `canary.test.ts` makes a `Secret` from a random value, called the canary. It logs the `Secret` in every shape. The shapes are a field, nested in objects, lists and a `Map`, an error's `cause`, and inside an `AggregateError`. It also logs copies of the read value. The copies appear in a message, in a `token` field, in JSON text, in base64, URI-encoded, and in an error message. It writes two audit rows with all of these in `detail` and in the text columns. Then it reads the raw log lines and the raw bytes of every file in the database folder, including the `-wal` file. It does this both while the store is open and after it is closed. The value must not appear anywhere, in plain, base64 or URI-encoded form.

The test also proves that each of those places really holds what was written. Each log record and each audit row carries its own random marker, which isn't secret. Each log line must hold its marker. The `-wal` file must hold each row's marker before SQLite copies it into the main file. After the store is closed, the test opens it again and reads back both rows with their markers.

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
| `SecretConstructionError` | `new Secret(...)`, or a subclass | Code tried to make a `Secret` without `Secret.make`. |
| `SecretSerializationError` | `JSON.stringify` | A `Secret` is anywhere in the value being converted. |
| `SecretWipedError` | `secret.reveal()` | The `Secret` was wiped. |
| `DataCloneError` | `structuredClone`, `MessagePort.postMessage` | A `Secret` is anywhere in the value being copied. |

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
| `op` | 1Password, through its SDK (the plugin comes in M3, [#17](https://github.com/jcore9/Aphelion/issues/17)) | `op://vault/item/field` or `op://vault/item/section/field` | `op://AI Agents/GitHub App/private key` |
| `bws` | Bitwarden Secrets Manager | `bws://` and the secret's ID | `bws://64246aa4-70b3-4332-8587-8b1284ce6d76` |
| `local` | The server's own encrypted store (M0-14b) | `local://` and one or more names separated by `/` | `local://github/webhook-secret` |

The scheme must be lowercase. Any other scheme is refused.

**`op`** follows 1Password's [secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax), read on 2026-11-22, with stricter rules that are Aphelion's policy:

- The path has three or four names. These are the vault, the item, an optional section, and the field. This is 1Password's rule.
- Each name is made of the letters `A` to `Z` and `a` to `z`, the digits, spaces, `-`, `_` and `.`. These are the characters 1Password supports. 1Password says to refer to a name with any other character, such as `ü`, by its ID. An ID is 26 letters and digits.
- Aphelion's policy allows only the ordinary space, and a name can't start or end with one. 1Password allows other whitespace, such as tabs, and spaces at the ends of a name. Aphelion refuses them, so that two references that look the same are the same.
- Aphelion's policy lets the reference end with one of three queries. `?attribute=otp` and `?attribute=totp` ask for the current one-time password code. `?ssh-format=openssh` asks for an SSH private key in the OpenSSH format. 1Password also documents attributes such as `type`, `id` and the file attributes. Aphelion refuses them, because they don't return a secret's value.
- `attr` may stand for `attribute`, as 1Password allows. The parser stores it as `attribute`, because 1Password's SDK docs show only `attribute`.
- The path is otherwise kept exactly as written. 1Password itself ignores case in references.

**`bws`** takes a Bitwarden Secrets Manager secret ID, which is a UUID. A UUID is 32 hexadecimal digits in groups of 8, 4, 4, 4 and 12, separated by `-`. Uppercase digits are accepted and stored in lowercase.

**`local`** takes one or more names separated by `/`. Each name starts with a lowercase letter or a digit, and then holds lowercase letters, digits, `.`, `-` and `_`. So `.` and `..` can't be names, and no name is empty.

### Reasons

| Cause | Reason |
| --- | --- |
| Not text, or longer than 1024 characters | `must be text of at most 1024 characters` |
| No scheme, or a scheme other than the three | `must start with op://, bws:// or local://` |
| A bad `op` path | `must be op://vault/item/field or op://vault/item/section/field, each name made of letters, digits, spaces, hyphens, underscores and dots` |
| A query other than the three | `may end only with ?attribute=otp, ?attribute=totp or ?ssh-format=openssh, and attr may stand for attribute` |
| A bad `bws` ID | `must be bws:// and a Bitwarden secret ID, such as bws://64246aa4-70b3-4332-8587-8b1284ce6d76` |
| A bad `local` name | `must be local:// and names made of lowercase letters, digits, dots, hyphens and underscores, separated by /, such as local://github/webhook-secret` |

The plugin manifest checks `permissions.secrets` with a looser rule, which only requires a scheme, `://` and visible characters ([plugin manifest](plugin-manifest.md)). The server's parser is the one that decides. For example, the manifest accepts `op://AI Agents/Wetter Zürich/credential`, and `parseSecretReference` refuses it, because `ü` must be written as the item's ID.
