# 0006. All bots share one Unix user; bots manage bots through tools

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Answers: M0 plan, Q2 (and makes Q8 obsolete)
- Amended by: [decision 0010](0010-bot-folders.md) (bot folders, and which changes need approval)
- Amended by: [decision 0016](0016-one-docker-container.md) (bots are started by a runner inside the container, not by systemd units)
- Amends: the plan's Trust boundaries, Session manager and Components sections, and issues M0-12 and M1-04

## Context

The plan runs every bot as its own Unix user, writing only to its own home and workspace. The owner wants bots to read and write each other's files, so a manager bot (for example a chief of staff) can oversee and edit the work of the others, and can change other bots' definitions.

One limit holds whatever the choice: bots can't run as the harness user. If they did, any bot could edit the policy file, the audit log or the managed hooks, and the approval layer would protect nothing.

## Options

How bots share files:

1. One shared `aphelion-bot` Unix user for every bot. All bots can read and write each other's workspaces, and the harness, its config and its database stay out of their reach.
2. One Unix user per bot, as planned, plus a shared group folder that all of them can read and write.
3. Bots run as the harness user. Rejected for the reason above.

How a manager bot changes another bot's definition (instructions, model, connectors, policy profile):

1. Built-in harness tools, gated by the approval layer and logged.
2. Not at all: bots share files only, and definitions change only from the client or the config.
3. Direct edits to the config files. Rejected: a prompt-injected bot could give another bot more permissions with no approval.

## Decision

Option 1 for both.

**One shared bot user.**

- The install script creates two users, `harness` and `aphelion-bot`, neither with sudo rights.
- Every bot's workspace lives under the `aphelion-bot` home, so bots can read and write each other's files.
- The config directory, the database, the audit log, the policy file and the root-owned managed hooks stay unreadable and unwritable to `aphelion-bot`.
- The harness starts bot processes as `aphelion-bot` through systemd: a template unit (`aphelion-bot@<name>.service`, `User=aphelion-bot`), plus a polkit rule that lets `harness` start and stop only units matching that template. The harness holds no root and no capabilities. Each bot still gets its own cgroup, so cancel kills its whole process tree, and M4-04 can set per-bot CPU and memory limits. This mechanism was the recommended answer to Q2, and it is confirmed with this record's approval.

**Bot management tools.**

- Alongside the messaging tools from M4-06, the harness gives bots tools to list, create, edit and archive bots.
- Every call goes through the policy engine and lands in the audit log.
- Default policy (superseded by the table in [decision 0010](0010-bot-folders.md), which moves instructions into each bot's folder):

| Change | Risk class | Default |
| --- | --- | --- |
| Read another bot's definition | read | allow |
| Edit instructions or model | write | reviewer (asks you until M8 adds the reviewer) |
| Create or archive a bot | destructive | always asks you |
| Change connectors, policy profile, workspace or provider | destructive | always asks you |
| Edit its own definition or policy profile, or the policy file | n/a | denied by the hard floor |

## Consequences

- **Less isolation between bots, by design.** A prompt-injected bot can read or damage any other bot's workspace. Recovery relies on VM snapshots and backups, and on git for anything in a repo. The threat model doc has to say this plainly.
- **Shared CLI logins.** Claude Code and Grok Build keep their sign-ins and session transcripts in the user's home, so every bot shares one subscription login, and any bot can read any other bot's transcripts. That matches using one subscription per provider. Workspaces and session ids are still tracked per bot.
- **The approval layer is unaffected.** The policy engine, the managed hooks and the credentials stay outside the bots' reach, exactly as before.
- **Simpler install.** Q8 (adding bot users after install) goes away, because a new bot needs no new Unix user.
- **Plugins are a separate question.** Server plugins still run under their own Unix users as the plan says (M0-13), started by the same systemd mechanism.
- **Issues change.** M0-12 creates `harness` and `aphelion-bot` instead of one user per bot. M1-04 runs each bot as `aphelion-bot` in its own systemd unit instead of under its own Unix user. M4-09 ([#91](https://github.com/jcore9/Aphelion/issues/91)) adds the bot management tools. M0-16 updates the plan text when it moves the plan into the docs site.
