# Device tokens

A device token is a long random password that one of the owner's devices, such as a laptop or a phone, sends with every request to the server. The server answers nothing but `GET /health` without one ([decision 0022](../decisions/0022-bot-network-boundary.md)). [The server reference](server.md) shows what each request gets.

## The life of a token

1. **Add.** `aphelion device add <name>` prints a new token once ([the `aphelion` command](cli.md#aphelion-device-add-name)). The server keeps only a fingerprint of it, so a lost token can't be shown again. Add a new device instead.
2. **Use.** The device sends the token in the `Authorization` header of each request, as `Authorization: Bearer aph_dev_…`.
3. **Expire.** A token stops working 90 days after it was added, unless `device add --days` gave it another lifetime, from 1 to 365 days.
4. **Revoke.** `aphelion device revoke <id>` stops a token at once. A WebSocket that uses it closes within 5 seconds. `aphelion device list` shows each device's id.

## What a token looks like

```
aph_dev_3f9c2a71d04be856_Q2xhdWRlIHdyb3RlIHRoaXMgZXhhbXBsZSB0b2tlbgA
```

| Part | Holds |
| --- | --- |
| `aph_dev_` | A fixed prefix. The log redactor removes any text that starts with it ([logging](logging.md#by-value-pattern)). |
| 16 hex digits | The device id. It isn't secret, and it appears in the audit log. |
| `_` and 43 characters | 32 random bytes, written in base64url (letters, digits, `-` and `_`) |

## How the server stores a token

The `devices` table holds one row per device. Migration 2 creates it ([the store](store.md#migrations)).

| Column | Holds |
| --- | --- |
| `id` | The device id, 16 hex digits |
| `name` | The name given to `device add`: 1 to 64 characters, no control characters, no spaces at either end |
| `token_hash` | The SHA-256 fingerprint of the whole token, 32 bytes |
| `created_at`, `expires_at` | When the token was made and when it stops working, as UTC timestamps |
| `revoked_at` | When it was revoked, or empty |

The token itself is never stored. SHA-256 turns the token into a fingerprint that can't be turned back into the token.

Passwords are usually stored with a deliberately slow hash, such as Argon2 or bcrypt. A slow hash makes each guess costly, which matters because people pick passwords from a small set of likely words. A device token is 32 random bytes, so there are 2²⁵⁶ possible tokens. Even at a trillion fast guesses a second, finding one would take far longer than the age of the universe. A slow hash would add nothing but delay to every request.

## How the server checks a token

For each request except `GET /health`:

1. Read the `Authorization` header. It must be `Bearer`, one space, and a token in the shape above.
2. Find the device by the id inside the token.
3. Compare the SHA-256 fingerprint of the token with the stored one, with `timingSafeEqual`. That function takes the same time whether the first byte differs or the last, so an attacker can't learn the fingerprint by timing replies. The comparison runs even when the token is malformed or the device unknown.
4. Refuse a revoked or expired token.

A missing, malformed, wrong, unknown, expired or revoked token all get the same reply: `401` with an empty body and the same headers. A caller can't tell which check failed. A token in the query string, such as `?token=…`, isn't read.

## What is audited

Each of these writes a row to the [audit log](logging.md#the-audit-log). No row holds a token.

| Action | Actor | Outcome | Detail |
| --- | --- | --- | --- |
| `device.add` | `cli` | `succeeded` | `device` (the id), `name`, `expiresAt` |
| `device.revoke` | `cli` | `succeeded`, or `failed` when the id is unknown, malformed or already revoked | `device`, when the id is well formed |
| `device.authenticate` | `server` | `denied` | `reason`, `claimedDevice` (the id inside the token, which an attacker can make up), `suppressedBefore` |

`reason` is `malformed`, `unknown`, `wrong`, `expired` or `revoked`. A request with no `Authorization` header isn't audited, because it didn't try a token.

Failed attempts write at most 10 rows a minute, so a flood of bad tokens can't fill the audit table. Attempts over the limit are counted, and the next row that is written gives the count in `suppressedBefore`.

## Keeping the token out of logs

- `addDevice` registers each new token with `maskSecretValue`, so the redactor replaces that exact text, and its base64 and URL-encoded forms, in every log line and audit row written by the same process ([logging](logging.md#known-secret-values)).
- The `aph_dev_` pattern catches a token the process didn't create, such as one a client sent.
- The field name `token` is redacted wherever it appears.

A test adds a device, logs the token and the result in several shapes, tries it as a bad token, and then reads the log lines and the database files byte by byte. None of them holds the token.

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/devices/index.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/devices/index.ts) | `addDevice`, `listDevices`, `revokeDevice`, `checkAuthorization`, `isDeviceActive` and the failed-attempt audit limit |
| [`apps/server/src/devices/token.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/devices/token.ts) | The token format, the SHA-256 fingerprint and the constant-time comparison |
| [`apps/server/src/store/migrations/0002-devices.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/store/migrations/0002-devices.ts) | The `devices` table |

The `aphelion device` commands call them from `@aphelion/server/devices`:

```ts
import { addDevice, revokeDevice } from "@aphelion/server/devices";

const { id, token } = addDevice(db, { name: "laptop" });
// Print `token` once. It can't be read again.

revokeDevice(db, id); // true if this call revoked it
```

## Known limits

- **Browsers.** A browser's WebSocket API can't set the `Authorization` header. M0's clients are `curl` and native programs, which can. The web client in M5 needs another way to send the token.
- **Tailnet identity.** The server can't yet check which tailnet device sent a request. [The M0-10b finding](../spikes/M0-10b-tailscale-whois.md) explains why, and [#142](https://github.com/jcore9/Aphelion/issues/142) adds it in M5.
- **Names.** Two devices may share a name. Revoke by id.
