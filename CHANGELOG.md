# Changelog

One section per release tag ([decision 0003](docs/decisions/0003-release-versioning.md)).

## v0.1.0-alpha.1 (M0 foundations)

The first alpha. It is a server you can install and check. It has no bot yet.

What ships:

- A headless server in one hardened Docker container, with a systemd unit and a preflight check that runs before it starts ([install guide](docs/guides/install.md)).
- Port 7400 is published on the host's Tailscale address only. Every call except `/health` needs a device token.
- Device tokens (`aphelion device add`, `list`, `revoke`) and a `/ws` WebSocket for clients.
- A secrets broker. A bootstrap key, sealed by systemd on the host, unlocks the secrets.
- Plugins with a server part, a client part, or both. You approve each plugin by its digest, and each gets only the permissions you grant.
- Plugin updates from GitHub releases, with a preview, your approval and a rollback.
- `aphelion config check`, which also checks the Compose file's published ports.
- Redacted logs, an audit table and a forward-only database migration runner.
- A backup and restore guide, a restore drill and the M0 exit test, which passed on 2026-11-24.

Known limits:

- No bot runs yet. Bots start in M1.
- A restore can bring back old device tokens and plugin approvals. Review them before you reopen access.
- Run only plugins you wrote or control. Plugins share one Unix user, and the permissions don't limit connections a plugin opens itself.
- A new local backup overwrites the last one before it is verified.
- The installer checks the shape of the recovery key, not that it is valid.
- Plugin queue limits count text length, not bytes.
- The deployed plugin host offers events, network and logging. Settings, storage and secret operations aren't enabled yet.
- ufw with `MANAGE_BUILTINS=yes` can drop Docker's rules on reload, so preflight refuses to start.
- Only Claude sign-in was tested. Codex and Grok sign-in are untested.
- The exit test used one host with a local backup copy and no hardware key.
