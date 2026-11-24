# 0059. A backup is one archive of the six volumes plus the key's recovery copy, and the M0 exit test restores it on a second VM

- Status: Proposed
- Date: 2026-11-23
- Decided by: project owner
- Proposed by: the M0-23 PR ([#168](https://github.com/jcore9/Aphelion/issues/168))
- Answers: [#168](https://github.com/jcore9/Aphelion/issues/168), four questions on how Aphelion's data is backed up and restored
- Amends: the M0 exit test, and the install guide's note that there is no tested way to restore a volume. The issue text names a `./plugins` folder. Plugins now live in the `plugin-files` volume ([decision 0057](0057-plugin-updates-from-github-releases.md) and the install guide).
- Relies on: [0050](0050-bootstrap-key-is-the-store-key.md) (the bootstrap key is the only key to the secrets store)

## Context

Nobody had tested restoring Aphelion's data on a new host. The install guide said so in one sentence. A backup that was never restored may not work, and you find that out on the worst day.

The container keeps its data in six Compose volumes: `config`, `state`, `bots`, `secrets`, `plugin-data` and `plugin-files`. A volume is a folder that Docker keeps for the container. The bootstrap key is not in any of them. The host seals it with `systemd-creds`, and the install guide already asks for a recovery copy in a password manager.

The owner answered four questions on 2026-11-23.

## Options

### 1. Who rehearses the commands, and who runs the full drill

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| The orchestrator rehearses the commands with Docker on the dev box. The owner runs the full drill on two fresh Ubuntu VMs in the M0 exit test, and pastes the output in the PR. | owner | The commands are checked before the owner spends time. The VM run covers what Docker alone can't: `host/install`, `systemd-creds` and a real second host. | Two runs, and the VM output arrives after the docs are written. |
| Only the owner's VM run | | One run. | The owner finds typing mistakes in the commands. |

### 2. What a backup holds

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| The key's recovery copy plus all six volumes | owner | One rule with no exceptions. Nothing is missed when the file layout changes. | The archive is larger than the minimum, and it holds plugin files that could be downloaded again. |
| Only `secrets`, `state` and `plugin-data`, with plugins downloaded again | | A smaller archive. | A plugin that can't be downloaded again is lost. |

A plugin can still be installed again instead of restored. Its approval, kept in `state`, records the plugin's folder and a digest of its files. A copy that is installed again must go in the same folder with the same files, byte for byte. Otherwise the server doesn't start the plugin, and the owner approves it again.

### 3. Where the steps go

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| A new "Back up and restore" section in the install guide. The exit test links it. | owner | The commands live where the owner installs. The plan stays short. | The exit test depends on a guide anchor. |
| The steps inside the exit test | | One place for the drill. | The guide would keep saying there is no tested way. |

### 4. The bootstrap key during the drill

The issue says the key is never printed. The real recovery steps show it on screen twice: when the owner copies it to the password manager on VM A, and when the owner pastes it on VM B. The drill VMs hold only test data, so the key is a throwaway.

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Show it on the owner's screen, and don't record those two steps | owner | The drill tests the steps the owner would use after a disk failure. The key never reaches the PR or a log. | The key is on screen for a moment. |
| Send it from A to B with one `ssh` command, so it is never on screen | | Nothing shows the key. | It doesn't test the password-manager steps, and it needs `sudo` without a password on VM B. |

## Decision

All four answers are as the owner picked.

- The orchestrator rehearses the commands with Docker. The owner runs the drill on two VMs during the M0 exit test, backs up on VM A, restores on VM B, and pastes the output into the PR.
- A backup is the bootstrap key's recovery copy plus one archive of the six volumes. The service is stopped before the archive is written, so the database is whole. The archive keeps numeric owners and access modes. Restore creates the six volumes, unpacks the archive into them, and only then starts the service, so the secrets broker never creates an empty store.
- "The key is never printed" means the key never appears in the drill output, the PR or a log. The owner doesn't record the two steps that show it.
- The steps are in [Back up and restore](../guides/install.md#back-up-and-restore). The drill uses test data only and checks three things: an encrypted secrets entry reads back, an installed plugin's approval survived, so the plugin starts with no new approval, and the database history is there. A failed check is written in the retro note. If restore doesn't work, the steps stay and a follow-up issue is filed. This record doesn't fix restore code.

The archive holds the database and the bot folders as plain files. Only the `secrets` volume is encrypted, by the bootstrap key. The guide says to store the archive on encrypted storage, apart from the key's copy.

## Consequences

- The M0 exit test gains step 7, the restore drill. The install guide gains the section and a rewritten note in "Restore on new hardware".
- The Docker rehearsal passed all three checks and the wrong-key refusal, with synthetic keys. The log is in the PR. The VM drill has not run yet.
- No `aphelion` command reads a secret or lists plugins. The checks use `bun` for the secret, the server log for the plugin, and `aphelion device list` for the history. A command that shows these would make the drill shorter. It needs its own issue.
- Restore makes the volumes by hand with Compose's labels, because Compose warns about volumes it didn't make, and `docker compose down -v` skips them.
- Revisit this record when:
  - the VM drill finds a failure,
  - a seventh volume appears, or
  - a backup command is added to `aphelion`.
