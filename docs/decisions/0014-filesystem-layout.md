# 0014. Config in /etc/aphelion, state in /var/lib/aphelion, agents in /var/lib/aphelion-agents

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q6

## Context

The harness must be able to write the config directory, because the web client edits the policy file, and agents must not be able to read or write it. [Decision 0010](0010-agent-folders.md) left the agents root to be settled here.

## Decision

| Path | Owner and mode | Holds |
| --- | --- | --- |
| `/etc/aphelion/` | `harness`, 0750 | Agents' config entries, policy, routines, connectors; can be a git repo |
| `/var/lib/aphelion/` | `harness`, 0700 | SQLite database, audit log and other server state |
| `/var/lib/aphelion-agents/` | `aphelion-agent`, group-readable by `harness` | One folder per agent ([decision 0010](0010-agent-folders.md)) |
| `/var/lib/aphelion-secrets/` | `aphelion-secrets`, 0700 | The broker's encrypted store ([decision 0012](0012-secrets-broker-process.md)) |

All four can be overridden for development, and the config check (`aphelion config check`) refuses to start if the ownership or modes are looser than this.

## Consequences

- M0-06 and M0-12 use these paths, and the install guide documents them.
- The exit test checks that `aphelion-agent` can't read `/etc/aphelion/` or `/var/lib/aphelion/`.
