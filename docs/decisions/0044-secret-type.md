# 0044. `Secret` is a small class of Aphelion's own, modelled on Effect's `Redacted`, and it throws when serialized

- Status: Proposed
- Date: 2026-11-22
- Proposed by: the M0-14a PR ([#103](https://github.com/jcore9/Aphelion/issues/103))
- Answers: [decision 0041](0041-effect-in-server-and-cli.md)'s "M0-14a may build `Secret` on `Redacted`. That PR decides.", and the owner's question of 2026-11-22: should serializing a `Secret` throw, or return a marker that the store and the pipes refuse?

## Context

`Secret` is the first of the three layers that keep secrets out of logs and the database ([decision 0036](0036-logging-library.md#owner-decision-2026-11-22-structure-first-patterns-as-a-backup)). The owner set what it must do on 2026-11-22:

- Printing it shows `<redacted>`, or a label, never the value.
- Serializing it fails loudly, so a value can't quietly reach the database or cross a process pipe.
- The value lives in a private field, and one explicit call reads it.
- It can be wiped.
- It hooks into the logger. It answers the `Symbol.for("aphelion.redactSelf")` hook, calls `maskSecretValue` when it is made, and calls `unmaskSecretValue` when it is wiped. If `maskSecretValue` throws `MaskListFullError`, no `Secret` is made.

Effect's `Redacted` is a wrapper that hides a secret when it is printed ([decision 0041](0041-effect-in-server-and-cli.md#effect-terms-used-on-this-page)). The server doesn't depend on Effect yet.

## Options

### What to build `Secret` on

This was measured on 2026-11-22 with Bun 1.4.5 and `effect` 4.1.5, loaded from Bun's install cache. The probe was outside the repo and was deleted. Each wrapper held the same value with the label `GitHub token`.

| | Effect's `Redacted` | A class of our own |
| --- | --- | --- |
| `String()` and `console.log` | `<redacted:GitHub token>` | `<redacted:GitHub token>` |
| `JSON.stringify` | Returns `"<redacted:GitHub token>"`, with no error | Throws `SecretSerializationError` |
| `structuredClone` | Returns `{"label":"GitHub token"}`, with no error | Throws `DataCloneError` |
| Where the value lives | A table inside the `effect` module, keyed by the wrapper | A `#value` field, which JavaScript hides from all code outside the class |
| Wipe | `Redacted.wipeUnsafe`. Its own docs say it "does not zero memory". | `wipe()`. It can't zero memory either, because JavaScript strings can't be overwritten. |
| The logger's `redactSelf` hook, masks and loud serialization | Not there. A class of our own would have to wrap the `Redacted` to add them. | In the class |
| Cost | Adds `effect` to the server, about 69 MB on disk ([decision 0041](0041-effect-in-server-and-cli.md#what-was-measured)) | About 90 lines, no dependency |

A `Redacted` can't be extended. `Redacted.make` builds it from a fixed prototype. So building on `Redacted` means our own class holds a `Redacted` and adds every behaviour the owner asked for. The `Redacted` would then only store the value, which a `#value` field already does.

### What serializing does

| | Throw | Return a marker that sinks refuse |
| --- | --- | --- |
| A `Secret` in `JSON.stringify` | Throws at the call, with a stack trace that points at the mistake | Returns a marker string. The JSON looks valid. |
| What each sink must do | Nothing. The store, the runner pipes and any later sink are covered without a change. | Search every value for the marker before it writes. A sink that forgets writes the marker, and the real data is lost with no error. |
| Logs and the audit log | Work. The redactor calls `redactSelf` before it looks at `toJSON` ([decision 0036](0036-logging-library.md)), so it never calls the method that throws. | Work |
| Cost | Code that serializes an object holding a `Secret` crashes. That is the point. | One check per sink, forever |

## Decision

`Secret` is a class of Aphelion's own, in `packages/server/src/secrets/secret.ts`. It copies `Redacted`'s printing: `<redacted>`, or `<redacted:label>` with a label. Its `toJSON` method throws `SecretSerializationError`.

The record separates two things that code can do with a `Secret`:

- **Turning it into text** gives the placeholder. That covers `String()`, template strings, `+` with a string, `console.log`, `util.inspect`, `util.format`, error messages, `new Blob([secret])` and `Bun.write(path, secret)`. Text conversion can't fail loudly, because JavaScript calls `toString` for all of them.
- **Serializing it** throws. That covers `JSON.stringify` (`SecretSerializationError`), and `structuredClone` and `MessagePort.postMessage` (`DataCloneError`), wherever the `Secret` sits inside the value.

The rules that follow:

- `Secret.make(value, { label })` is the only way to make a `Secret`. The constructor requires a token that only `Secret.make` holds, so `new Secret(...)` and a subclass throw `SecretConstructionError` at run time. TypeScript's `private constructor` alone doesn't do this, because it disappears when the code runs.
- The constructor registers the value with `maskSecretValue` before it stores it. A `MaskListFullError` stops it, and no `Secret` exists. So only a `Secret` that registered a value can unmask it, and `wipe()` on any other object throws a `TypeError`.
- `secret.reveal()` is the one way to read the value. It throws `SecretWipedError` after a wipe.
- Each `Secret` holds a symbol in its `cloneGuard` property. The structured clone algorithm refuses symbols, so `structuredClone` throws a `DataCloneError` for a `Secret`, and so does any channel that copies messages that way.
- Each `Secret`, the class and its prototype are frozen. Code can't delete `cloneGuard` or replace a method. A spread or `Object.assign` copies only `label` and `cloneGuard`, and neither is a function.
- `secret.wipe()` calls `unmaskSecretValue` and drops the value.
- The mask list now counts registrations. A value stays masked until every `maskSecretValue` call for it has a matching `unmaskSecretValue`. Before this, wiping one of two `Secret`s with the same value would have unmasked a value that the other still held.
- `Secret` lives in `packages/server`. Plugins never see a secret's value ([decision 0042](0042-plugin-server-and-client-parts.md)).

### Secret references

The same PR adds `parseSecretReference`, which turns text such as `op://vault/item/field` into a scheme and a path. The [secrets reference](../reference/secrets.md#secret-references) lists the full rules. These are choices:

- `op://` follows 1Password's [secret reference syntax](https://www.1password.dev/cli/secret-reference-syntax), read on 2026-11-22. Names use only the characters 1Password supports: ASCII letters, digits, spaces, `-`, `_` and `.`. 1Password says to refer to a name with any other character by its ID. So `op://vault/Wetter Zürich/field` is refused, and the item's ID works.
- `op://` is stricter than 1Password in three ways. These are Aphelion's policy, not 1Password's rules. A name can hold only the ordinary space, and not at its start or end, so that two references that look the same are the same. 1Password allows tabs and spaces at the ends. Only three queries are accepted: `attribute=otp`, `attribute=totp` and `ssh-format=openssh`. The other attributes 1Password documents, such as `type` and `id`, don't return a secret's value. The scheme must be lowercase.
- `?attr=` is accepted as the alias for `?attribute=`, as 1Password allows, and stored as `attribute`. 1Password's SDK docs show only `attribute`, so the broker passes the SDK the documented form.
- `local://` names are lowercase, so two references can't differ only in case.
- `bws://` takes a UUID, the form Bitwarden's CLI shows for every secret ID. Bitwarden's docs show the form but don't state it as a rule.

## Consequences

- No `Secret` can be serialized by accident. A crash with `SecretSerializationError` means code tried to store or send one. The fix is to keep the `Secret` out of that value, not to catch the error.
- `@typescript-eslint/restrict-template-expressions` already refuses a `Secret` inside a template string. The test that checks the template output turns that rule off for one line.
- The broker (M0-14b) and the 1Password plugin (M0-15) create `Secret`s with `Secret.make`, and wipe them when they are done.
- When the server adopts Effect for other reasons, `Secret` stays as it is. Revisit this record if Effect's `Redacted` gains a way to fail on serialization and a hook for the logger.
