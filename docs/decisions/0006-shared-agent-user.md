# 0006. All agents share one Unix user; agents manage agents through tools

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q2 (and makes Q8 obsolete)
- Amended by: [decision 0010](0010-agent-folders.md) (agent folders, and which changes need approval)
- Amends: the plan's Trust boundaries, Session manager and Components sections, and issues M0-12 and M1-04

## Context

The plan runs every agent as its own Unix user, writing only to its own home and workspace. The owner wants agents to read and write each other's files, so a manager agent (for example a chief of staff) can oversee and edit the work of the others, and can change other agents' definitions.

One limit holds whatever the choice: agents can't run as the harness user. If they did, any agent could edit the policy file, the audit log or the managed hooks, and the approval layer would protect nothing.

## Options

How agents share files:

1. One shared `aphelion-agent` Unix user for every agent. All agents can read and write each other's workspaces, and the harness, its config and its database stay out of their reach.
2. One Unix user per agent, as planned, plus a shared group folder that all of them can read and write.
3. Agents run as the harness user. Rejected for the reason above.

How a manager agent changes another agent's definition (instructions, model, connectors, policy profile):

1. Built-in harness tools, gated by the approval layer and logged.
2. Not at all: agents share files only, and definitions change only from the client or the config.
3. Direct edits to the config files. Rejected: a prompt-injected agent could give another agent more permissions with no approval.

## Decision

Option 1 for both.

**One shared agent user.**

- The install script creates two users, `harness` and `aphelion-agent`, neither with sudo rights.
- Every agent's workspace lives under the `aphelion-agent` home, so agents can read and write each other's files.
- The config directory, the database, the audit log, the policy file and the root-owned managed hooks stay unreadable and unwritable to `aphelion-agent`.
- The harness starts agent processes as `aphelion-agent` through systemd: a template unit (`aphelion-agent@<name>.service`, `User=aphelion-agent`), plus a polkit rule that lets `harness` start and stop only units matching that template. The harness holds no root and no capabilities. Each agent still gets its own cgroup, so cancel kills its whole process tree, and M4-04 can set per-agent CPU and memory limits. This mechanism was the recommended answer to Q2, and it is confirmed with this record's approval.

**Agent management tools.**

- Alongside the messaging tools from M4-06, the harness gives agents tools to list, create, edit and archive agents.
- Every call goes through the policy engine and lands in the audit log.
- Default policy (superseded by the table in [decision 0010](0010-agent-folders.md), which moves instructions into each agent's folder):

| Change | Risk class | Default |
| --- | --- | --- |
| Read another agent's definition | read | allow |
| Edit instructions or model | write | reviewer (asks you until M8 adds the reviewer) |
| Create or archive an agent | destructive | always asks you |
| Change connectors, policy profile, workspace or provider | destructive | always asks you |
| Edit its own definition or policy profile, or the policy file | n/a | denied by the hard floor |

## Consequences

- **Less isolation between agents, by design.** A prompt-injected agent can read or damage any other agent's workspace. Recovery relies on VM snapshots and backups, and on git for anything in a repo. The threat model doc has to say this plainly.
- **Shared CLI logins.** Claude Code and Grok Build keep their sign-ins and session transcripts in the user's home, so every agent shares one subscription login, and any agent can read any other agent's transcripts. That matches using one subscription per provider. Workspaces and session ids are still tracked per agent.
- **The approval layer is unaffected.** The policy engine, the managed hooks and the credentials stay outside the agents' reach, exactly as before.
- **Simpler install.** Q8 (adding agent users after install) goes away, because a new agent needs no new Unix user.
- **Plugins are a separate question.** Server plugins still run under their own Unix users as the plan says (M0-13), started by the same systemd mechanism.
- **Issues change.** M0-12 creates `harness` and `aphelion-agent` instead of one user per agent. M1-04 runs each agent as `aphelion-agent` in its own systemd unit instead of under its own Unix user. M4-09 ([#91](https://github.com/jcore9/Aphelion/issues/91)) adds the agent management tools. M0-16 updates the plan text when it moves the plan into the docs site.
