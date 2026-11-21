# 0010. Each agent has a folder; instructions live there, permissions stay in the server's config

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amends: [decision 0006](0006-shared-agent-user.md) (which agent changes need approval)

## Context

The owner expects to run hundreds of agents, and wants them all under one Linux user, each with its own folder holding its workspace and the files that describe it. [Decision 0006](0006-shared-agent-user.md) already uses one shared user, but it kept every part of an agent's definition in the server's config, so even an edit to instructions went through an approved tool.

The question was which parts of an agent's description belong in its folder, where any agent can edit them, and which belong in the server's config, where agents can change them only through approved tools.

## Options

1. Split by risk: instructions, notes and memory live in the agent's folder; identity and permissions stay in the server's config.
2. Everything in the folder. Simplest, but any agent could give another agent more connectors or turn its approvals off.
3. Everything in the server's config, as 0006 had it. Folders hold only workspaces.

## Decision

Option 1.

**One Linux user for all agents.** `aphelion-agent` runs every agent, however many there are, and `harness` runs the server. (The secrets broker has its own user too, per [decision 0012](0012-secrets-broker-process.md), but that number never grows with the agent count.) Adding an agent creates a folder, not a user. Each running agent gets a systemd unit created on the fly from one template and discarded when the agent stops; it needs no setup.

**One folder per agent**, owned by `aphelion-agent`:

```
/var/lib/aphelion-agents/ the agents root (decision 0014)
  <agent name>/
    workspace/            repos, notes, scratch files
    <instructions file>   what the agent is told to do (its name is settled in M4-02)
    memory/               the agent's own notes and memory
```

Any agent can read and edit any agent's folder, so a chief of staff can rewrite another agent's instructions directly. The `harness` user can read these folders, through group membership, so it can hand instructions to the CLIs, but it treats their contents as untrusted data.

**The server's config** (owned by `harness`, unreadable to agents) holds what decides what an agent is *allowed* to do: its name, provider and model, connectors, approval profile, and the location of its folder. Agents change these only through the agent management tools ([#91](https://github.com/jcore9/Aphelion/issues/91)), with this default policy, which replaces the table in 0006:

| Change | How | Default |
| --- | --- | --- |
| Instructions, notes, memory | Edit the files in the agent's folder | No approval for the edit itself; the agent's file-write tool calls still pass its normal policy |
| Read another agent's definition | Tool | allow |
| Change model | Tool | reviewer (asks you until M8 adds the reviewer) |
| Create or archive an agent | Tool | always asks you |
| Change provider, connectors, approval profile or folder | Tool | always asks you |
| Edit its own definition or approval profile, or the policy file | n/a | denied by the hard floor |

## Consequences

- A tricked agent can change what another agent is *told* to do, with no approval. It can't change what that agent is *allowed* to do, because every action the other agent then takes still passes that agent's own policy.
- **Traceability.** At the start of each turn, the server writes a hash of the agent's instructions file to the audit log, so a change to instructions can be traced to when it took effect. Folders are covered by VM snapshots and backups.
- Scaling to hundreds of agents needs no install step per agent, so the separate root step for adding agents (Q8) stays obsolete.
- Issue changes: M0-12 ([#14](https://github.com/jcore9/Aphelion/issues/14)) creates the agents root owned by `aphelion-agent`, readable by `harness`. M4-02 ([#45](https://github.com/jcore9/Aphelion/issues/45)) defines agents in two parts, the folder and the config entry. M4-09 ([#91](https://github.com/jcore9/Aphelion/issues/91)) uses the policy table above.
