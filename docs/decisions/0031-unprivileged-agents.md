# 0031. Agents run as unprivileged users

- Status: Accepted
- Date: 2026-11-21
- Decided by: plan of record (imported in [0004](0004-import-plan-with-m0-plan.md))
- Answers: the plan's Open decisions, "Agent privileges"
- Amended by: [decision 0006](0006-shared-agent-user.md) (one shared `aphelion-agent` user instead of one user per agent)
- Amended by: [decision 0016](0016-one-docker-container.md) (the users live inside the server container)

## Context

The plan assumes that any agent can be prompt-injected. The approval layer only holds if an agent can't edit the policy file, the managed hooks, the audit log or the harness's config.

## Options

| Option | For | Against |
| --- | --- | --- |
| Keep root in the VM | Agents can install anything | An agent with root can rewrite the rules that gate it |
| Unprivileged users | The gate holds, because agents can't edit it | Agents can't install system packages |

## Decision

Agents run as unprivileged users with no sudo.

## Consequences

- [Decision 0006](0006-shared-agent-user.md) replaces the plan's "one Unix user per agent" with one shared `aphelion-agent` user, so agents can read and write each other's workspaces. The decision to run without root and without sudo stands.
- [Decision 0016](0016-one-docker-container.md) puts the users inside the server container, and [decision 0022](0022-agent-network-boundary.md) adds the network boundary around it.
