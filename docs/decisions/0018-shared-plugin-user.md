# 0018. Server plugins share one user and are started by a plugin runner

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0022](0022-bot-network-boundary.md) (the plugin runner channel uses init-created pipes, not `SO_PEERCRED`)
- Answers: M0 plan, Q9
- Amends: the plan's Plugin types table ("separate process under its own Unix user"), [0016](0016-one-docker-container.md) (the users in the image)

## Context

The plan runs each server plugin as its own Unix user. That relied on systemd starting processes as other users, and the container from [decision 0016](0016-one-docker-container.md) has no systemd. A user per plugin would also bring back a new user for every addition, which the owner rejected for bots in [decision 0010](0010-bot-folders.md).

## Options

1. One shared `aphelion-plugins` user for every server plugin, started by a plugin runner, with each plugin's permissions enforced by the host.
2. Plugins run as `harness`, inside the server's trust.

## Decision

Option 1.

- The image gains a fourth user, `aphelion-plugins`, and the init starts a **plugin runner** as that user, alongside the server, the broker and the bot runner.
- The plugin runner works like the bot runner: it starts one process per plugin on the server's request, over a Unix socket that accepts only `harness` (checked with `SO_PEERCRED`).
- Each plugin talks to the host over JSON-RPC on its own channel. The host only forwards the events and APIs that plugin was granted.
- `aphelion-plugins` can't read the server's files (`/etc/aphelion`, `/var/lib/aphelion`), the broker's store, or the bot folders. Each plugin gets its own data folder, `/var/lib/aphelion-plugins/<plugin id>/`.
- Plugins never see secret values directly; they request them through the host under their granted permissions.

| User | Runs |
| --- | --- |
| `harness` | The server |
| `aphelion-bot` | The bot runner and every bot |
| `aphelion-secrets` | The secrets broker |
| `aphelion-plugins` | The plugin runner and every server plugin |

The number of users is fixed at four, however many bots or plugins are added.

## Consequences

- Plugins are kept away from the approval rules, the database, secrets and bot workspaces by Unix users. Plugins aren't kept apart from *each other* by Unix users: one plugin could read another's data folder. Their access to Aphelion itself is limited by the host's permission grants. Per-plugin users can come back later as their own decision if a plugin needs stronger separation.
- M0-13 (b) builds the plugin runner. M0-12's image adds the user, the runner and the `/var/lib/aphelion-plugins/` volume.
- Connector plugins that move to the gateway host in M3 use the same runner design there.
- When M0-16 moves the plan into the docs site, it updates the Plugin types table.
