# 0050. The host's bootstrap credential is the local store's age key

- Status: Accepted (approved by merging #157 on 2026-11-23)
- Date: 2026-11-23
- Proposed by: the bootstrap secret PR ([#105](https://github.com/jcore9/Aphelion/issues/105))
- Answers: which secret the host delivers to the broker, and how the broker uses it to unseal the local store
- Amends: [decision 0020](0020-1password-grok-bot-style.md) (which credential the host delivers), the plan's "The bootstrap secret", and the M0 plan's M0-14 and M0-15 notes

## Context

The local store from [#104](https://github.com/jcore9/Aphelion/issues/104) encrypts each entry with [age](https://age-encryption.org), a small file encryption format. age encrypts to a public key, called a recipient, and decrypts with the matching private key, called an identity. In #104 the broker kept that identity in plain text in `identity.agekey`, in the same `secrets` volume as the entries. A copy of the volume could decrypt every entry.

Issue #105 says the host's `aphelion.service` loads a bootstrap secret with `LoadCredentialEncrypted=`, and that the broker unseals the local store with it. `LoadCredentialEncrypted=` is a systemd setting. It decrypts a file that `systemd-creds encrypt` made, and gives the plain value to the service in a private in-memory folder. [Decision 0021](0021-container-init-and-secret-handoff.md) already says how the value reaches the broker: Compose mounts it at `/run/secrets/bootstrap`, owned by root with mode `0400`, and the launcher passes it to the broker as standard input.

[Decision 0020](0020-1password-grok-bot-style.md) and the M0-15 note say the bootstrap secret is the 1Password service account token. The plan says it is the 1Password or Bitwarden token. Issue #105 says it unseals the local store. The two disagree on what the secret is for.

The orchestrator measured these facts in a privileged `ubuntu:26.04` container with systemd 259.9 as its first process, with no TPM:

- `systemd-creds encrypt --name=bootstrap` encrypted an age identity with the host key.
- A `Type=exec` unit with `LoadCredentialEncrypted=bootstrap:/etc/credstore.encrypted/aphelion-bootstrap` saw `CREDENTIALS_DIRECTORY=/run/credentials/t.service` in `ExecStartPre=` and `ExecStart=`.
- From outside the unit, where Docker runs, the file `/run/credentials/t.service/bootstrap` was `root:root 0400` on a read-only in-memory file system. `PrivateTmp=yes` didn't change that.
- `systemd-creds encrypt` wrote the encrypted file with mode `0644` under the default umask. It replaced an existing file without asking, and it sealed empty input without an error.

## Options

1. **The bootstrap credential is the store's age identity.** The host install makes a new identity once and seals it with `systemd-creds`. The broker reads it from standard input and keeps only the public key, `recipient.pub`, in the volume.
   - For: one key, one place, nothing private in the volume. The broker code gets shorter.
   - Against: a new host credential means encrypting every entry again. M0 has no rotation, so the cost is in the future.
2. **The credential wraps a store identity kept sealed in the volume.** The volume holds `identity.agekey` encrypted to the host credential.
   - For: the host credential can change without encrypting the entries again.
   - Against: one more layer and one more key file, for a rotation that M0 doesn't need.
3. **The 1Password service account token is the bootstrap secret**, as decision 0020 and the M0-15 note say.
   - For: the plan's text.
   - Against: the local store must work without 1Password, and it needs a key of its own either way. A provider token and the store key also have different owners and lifetimes. [#17](https://github.com/jcore9/Aphelion/issues/17) decides where the 1Password token lives, for example as a `local://` entry.

## Decision

Option 1.

- `deploy/host/install` creates `/etc/credstore.encrypted/aphelion-bootstrap` if it doesn't exist. It runs `aphelion-secrets --new-key` in the image, with no network and with Docker's log driver off, so the key that the container prints never reaches a Docker log. It pipes the key into `systemd-creds encrypt` under umask `077`, into a temporary file. It checks that the file decrypts to an age identity before it moves the file into place. It never replaces an existing credential, because losing it loses every secret. An existing credential that doesn't decrypt to an age identity stops the install.
- The broker reads the key from standard input, closes it, and opens the store with it. It refuses an empty key, an invalid key, a key that doesn't match the store, and a store that still holds `identity.agekey`. Each refusal logs a fixed reason, never the key.
- The store records `recipient.pub` on its first open. If entries exist and `recipient.pub` doesn't, the broker first checks every entry: each one must decrypt with the key and hold the reference path its filename was made from. `recipient.pub` catches a wrong key. It isn't protection against someone who can change files in the volume.
- The owner keeps a recovery copy of the key in a password manager. The [install guide](../guides/install.md#keep-a-recovery-copy-of-the-bootstrap-key) shows how to print it, and how to restore it on new hardware.

### What it protects

- A copy of the `secrets` volume alone can't decrypt any entry.
- With systemd's host key only, a full copy of the host disk can decrypt the entries. The disk holds both `/var/lib/systemd/credential.secret` and the encrypted credential.
- On a host with a TPM2 chip, `systemd-creds` tries to bind the credential to the chip as well. If that works, a copy of the disk alone can't decrypt it. Its default mode falls back to the host key alone when it can't use the chip, so the claim holds only when the binding succeeded. That case wasn't tested here.
- New hardware needs the recovery copy if the credential is bound to the old TPM. With the host key alone, it also works to move both `/var/lib/systemd/credential.secret` and the encrypted credential.
- Root on the running host can always read the key.

## Consequences

- Decision 0020 gets an `Amended by` line. The bootstrap secret is the store key, not the 1Password token.
- The plan's "The bootstrap secret" and the M0 plan's M0-14 and M0-15 notes are amended to match.
- A store made before #105 doesn't open while its `identity.agekey` exists. No install from before #105 holds real secrets, so the [install guide](../guides/install.md#start-a-fresh-store-after-an-older-install) deletes such a store instead of moving its key. A safe move would also have to find copies of the key that #104 could leave in temporary files after an interrupted first start.
- Rotating the key is out of scope for M0. Revisit this record when rotation is needed, or when option 2's extra layer pays for itself.
