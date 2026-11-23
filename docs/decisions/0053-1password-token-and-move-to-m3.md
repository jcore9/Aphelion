# 0053. The 1Password token lives in the local store, and the 1Password plugin moves from M0 to M3

- Status: Accepted
- Date: 2026-11-23
- Decided by: project owner
- Answers: where the 1Password service account token lives, how the live test that [decision 0015](0015-1password-ci-mock.md) requires gets run, and when [#17](https://github.com/jcore9/Aphelion/issues/17) (M0-15) is built
- Amends: the M0 plan's M0-15 notes and the plan's issue breakdown, which place the 1Password plugin in M0

## Context

The 1Password plugin turns `op://` references into secret values, using a 1Password service account. A service account is a limited 1Password login for software. Its token is a long string that works as its password, so the token needs a safe home.

[Decision 0050](0050-bootstrap-key-is-the-store-key.md) made the host's bootstrap credential the key of the broker's local store, and left the token's home to #17. [Decision 0042](0042-plugin-server-and-client-parts.md) left to #17 how the token reaches the plugin and how resolved values stay away from other plugins. [Decision 0015](0015-1password-ci-mock.md) says CI uses a mock, and that the #17 pull request shows the output of a manual run against a real vault of test items.

The M0 exit test is that the service starts on boot and answers `/health`. It doesn't use 1Password. The first features that use `op://` secrets are the connectors in M3.

## Options

### Where the token lives

1. **In the local store, as `local://1password/service-account-token`.**
   - For: it is encrypted by the bootstrap key, it is backed up with the store, and the host needs no new install step. The store already has delete and audit rows.
   - Against: anyone who can unseal the store can read it. That is true of every secret in the store.
2. **A second host credential sealed with `systemd-creds`, like the bootstrap key.**
   - For: nothing extra in the `secrets` volume.
   - Against: another install step, a change needs sudo and a restart, and restoring on new hardware needs a second recovery copy.
3. **A plain file in the plugin's data folder.**
   - For: the simplest to build.
   - Against: the file isn't encrypted, and every plugin runs as the same Linux user, `aphelion-plugins`, so any plugin could read it.

### When to build the plugin

1. **Move #17 to M3.** The issue keeps its ID, M0-15.
2. **Build it in M0 now, with a fake plugin to test the missing server piece.** Rejected. It spends M0 time on a feature no M0 test needs.
3. **Move it to M9 (Later).** Rejected. M3's connectors need it.

### The live test

1. **The owner makes a read-only service account for a vault that holds only test items and gives the token through a private secret prompt. The orchestrator runs the test.** The output never shows values, and goes in the pull request.
2. **The owner runs a script.** Rejected.

## Decision

- The token lives in the local store as `local://1password/service-account-token`, locked by the bootstrap key. The owner enters it once with an `aphelion` command that reads it from the keyboard, so it never goes through chat, a file or the command line. Disconnecting 1Password deletes it. Only the 1Password plugin receives it. Bots never do.
- #17 moves to milestone M3 and keeps its ID, M0-15.
- The live test follows option 1 above.

## Consequences

- Already in `dev`: the `op://` reference parser (`apps/server/src/secrets/reference.ts`), the `SecretBackend` type in the SDK, and `contributes.secretSchemes` in the manifest.
- Still to build in #17:
  - The host side that asks a backend plugin for a value. No JSON-RPC method for it exists, and nothing calls `SecretBackend.resolve`.
  - How the token reaches the plugin, and how resolved values are kept from other plugins.
  - The grant model, the CLI for grant decisions and the audit rows listed in the issue.
  - Packaging. `@1password/sdk` reads its WebAssembly file from disk at run time ([the M0-03 spike](../spikes/M0-03-headless-on-bun.md)), so the starter template's one-file bundle needs a change.
- The M0 plan and the plan's issue breakdown get an "Amended by" note. The reference pages for secrets and the plugin manifest say the plugin comes in M3.
- Decision 0020's text about M0-15 building the grant model now applies to M3.
- M1's Claude adapter is now the first first-party plugin built from the starter template, and the 1Password plugin comes after it.
- Revisit the token's home if the store gets a second key or a per-plugin access list.
