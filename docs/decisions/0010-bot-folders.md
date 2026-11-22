# 0010. Each bot has a folder; instructions live there, permissions stay in the server's config

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0022](0022-bot-network-boundary.md) (the server reads bot files only through a helper that refuses symlinks)
- Amended by: [decision 0016](0016-one-docker-container.md) (no per-bot systemd units; the runner starts bots)
- Amends: [decision 0006](0006-shared-bot-user.md) (which bot changes need approval)

## Context

The owner expects to run hundreds of bots, and wants them all under one Linux user, each with its own folder holding its workspace and the files that describe it. [Decision 0006](0006-shared-bot-user.md) already uses one shared user, but it kept every part of a bot's definition in the server's config, so even an edit to instructions went through an approved tool.

The question was which parts of a bot's description belong in its folder, where any bot can edit them, and which belong in the server's config, where bots can change them only through approved tools.

## Options

1. Split by risk: instructions, notes and memory live in the bot's folder; identity and permissions stay in the server's config.
2. Everything in the folder. Simplest, but any bot could give another bot more connectors or turn its approvals off.
3. Everything in the server's config, as 0006 had it. Folders hold only workspaces.

## Decision

Option 1.

**One Linux user for all bots.** `aphelion-bot` runs every bot, however many there are, and `harness` runs the server. (The secrets broker has its own user too, per [decision 0012](0012-secrets-broker-process.md), but that number never grows with the bot count.) Adding a bot creates a folder, not a user. Each running bot gets a systemd unit created on the fly from one template and discarded when the bot stops; it needs no setup.

**One folder per bot**, owned by `aphelion-bot`:

```
/var/lib/aphelion-bots/ the bots root (decision 0014)
  <bot name>/
    workspace/            repos, notes, scratch files
    <instructions file>   what the bot is told to do (its name is settled in M4-02)
    memory/               the bot's own notes and memory
```

Any bot can read and edit any bot's folder, so a chief of staff can rewrite another bot's instructions directly. The `harness` user can read these folders, through group membership, so it can hand instructions to the CLIs, but it treats their contents as untrusted data.

**The server's config** (owned by `harness`, unreadable to bots) holds what decides what a bot is *allowed* to do: its name, provider and model, connectors, approval profile, and the location of its folder. Bots change these only through the bot management tools ([#91](https://github.com/jcore9/Aphelion/issues/91)), with this default policy, which replaces the table in 0006:

| Change | How | Default |
| --- | --- | --- |
| Instructions, notes, memory | Edit the files in the bot's folder | No approval for the edit itself; the bot's file-write tool calls still pass its normal policy |
| Read another bot's definition | Tool | allow |
| Change model | Tool | reviewer (asks you until M8 adds the reviewer) |
| Create or archive a bot | Tool | always asks you |
| Change provider, connectors, approval profile or folder | Tool | always asks you |
| Edit its own definition or approval profile, or the policy file | n/a | denied by the hard floor |

## Consequences

- A tricked bot can change what another bot is *told* to do, with no approval. It can't change what that bot is *allowed* to do, because every action the other bot then takes still passes that bot's own policy.
- **Traceability.** At the start of each turn, the server writes a hash of the bot's instructions file to the audit log, so a change to instructions can be traced to when it took effect. Folders are covered by VM snapshots and backups.
- Scaling to hundreds of bots needs no install step per bot, so the separate root step for adding bots (Q8) stays obsolete.
- Issue changes: M0-12 ([#14](https://github.com/jcore9/Aphelion/issues/14)) creates the bots root owned by `aphelion-bot`, readable by `harness`. M4-02 ([#45](https://github.com/jcore9/Aphelion/issues/45)) defines bots in two parts, the folder and the config entry. M4-09 ([#91](https://github.com/jcore9/Aphelion/issues/91)) uses the policy table above.
