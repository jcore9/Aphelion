# 0039. Aphelion's bots are called bots, not agents, in the code, the docs and the issues

- Status: Accepted (approved by merging #149 on 2026-11-22)
- Date: 2026-11-22
- Proposed by: the rename PR ([#149](https://github.com/jcore9/Aphelion/pull/149)), for issue [#147](https://github.com/jcore9/Aphelion/issues/147)
- Answers: the owner's choice of 2026-11-22 to call Aphelion's bots "bots", and the questions it raised: old records' text, the audit log's `agent_id` column, the config file `agents.yaml`, and open GitHub issues
- Amends: the plan's "Its bots (called agents throughout this plan)", the file names of decisions [0006](0006-shared-bot-user.md), [0010](0010-bot-folders.md), [0022](0022-bot-network-boundary.md), [0024](0024-codex-third-bot-cli.md) and [0031](0031-unprivileged-bots.md), and the word "agent" in earlier records, except where the Kept list below says otherwise

## Context

The plan opened with "Its bots (called agents throughout this plan)". So one thing had two names, and the code, the docs and the issues used "agent". On 2026-11-22 the owner chose "bot" as the one word, and asked for the rename now, while little code exists.

"Agent" also means things that aren't Aphelion's bots:

- **Vendor names.** The Agent Client Protocol (ACP), Anthropic's Claude Agent SDK, Grok's `grok agent stdio` command, and the mode names in `codex-acp`, such as `agent-full-access`.
- **Coding agents.** The tools that write Aphelion's own code, such as Claude Code in T3 Code. Their PRs carry the `agent-authored` label.

The owner chose the scope from these kinds of name: rename Aphelion's own names, and keep the other two.

## Options

### Old decision records and spike reports

| Option | For | Against |
| --- | --- | --- |
| **Rename the word in their text too** | Every page uses one word. The word names the same thing, so no record's decision changes. Git keeps the old wording | Approved records change wording without a new approval |
| Rename only file names, titles and links | Records keep the words they were approved with | Pages mix "bot" and "agent" for the same thing |

[Decision 0047](0047-repo-layout.md) kept old records' text when folders moved, because a path in a record says where the code was at the time. A rename of a word doesn't change any fact a record states, so this record takes the other option.

### The audit log's `agent_id` column

Migration 0001 created the `audit_log` table with a column named `agent_id`. A migration that has merged is never edited, because a database that already ran it would never see the change.

| Option | For | Against |
| --- | --- | --- |
| **A new migration, 0003, renames the column to `bot_id`** | The database uses the same word as the code. SQLite renames a column in place and keeps its rows | Rows written before 0003 keep the actor kind `agent`, because the table refuses updates |
| Keep `agent_id` | No migration | The code's `botId` is stored as `agent_id` for good |

### The config file `agents.yaml`

Config migrations ([decision 0025](0025-config-schema-and-format.md)) move one file's version forward. They can't rename a file.

| Option | For | Against |
| --- | --- | --- |
| **Rename it to `bots.yaml`, still at version 1, with no migration** | Simple. No release of Aphelion exists, so only a developer's own test config can have an `agents.yaml` | That config stops loading until its developer renames the file to `bots.yaml` and its top-level key `agents:` to `bots:` |
| Also read `agents.yaml` when `bots.yaml` is missing | Old files keep working | Code for files that don't exist anywhere, kept for good |

### Open GitHub issues

| Option | For | Against |
| --- | --- | --- |
| **A second script, with the same rules, edits the open issues' titles and bodies once the owner approves the list** | Issues match the docs the PR changes | It edits text outside the PR |
| Leave issues alone | No edits outside the PR | Open issues keep "agent" until each one is built |

## Decision

Take the options in bold above. One script makes the rename, and its exceptions list says what stays. The PR for #147 holds the script and the list.

**Renamed:**

- The word, in every doc, code comment, test and message: "agent" becomes "bot", and "an agent" becomes "a bot".
- The Unix user `aphelion-agent` becomes `aphelion-bot`, and `/var/lib/aphelion-agents` becomes `/var/lib/aphelion-bots`.
- The agent runner becomes the bot runner, agent adapters become bot adapters, and an agent CLI (the vendor CLI a bot runs on, such as Codex) becomes a bot CLI.
- `agents.yaml` becomes `bots.yaml`, its top-level key `agents` becomes `bots`, and its schema file becomes `bots.schema.json`.
- Code names: `agentId` becomes `botId`, and the audit log's actor kind `agent` becomes `bot`. Names in the plan and in examples follow, such as the events `bot.status` and `bot.message`, the UI slot `bot.sidebar` and the branch prefix `bot/*`.
- The audit log's column `agent_id` becomes `bot_id`, in migration 0003.
- The five decision records whose file names said "agent". Every link to them is updated.

**Kept:**

- Vendor names, package names, URLs and quotes, as their authors spell them.
- Coding agents, their PRs, and the `agent-authored` label.
- `AI Agents`, the example name of the 1Password vault.
- Lines that describe 1Password for Agents, which is a vendor product.
- Migration 0001, as merged.

## Consequences

- New code and docs say "bot". The exceptions list is the reference for the few places that still say "agent".
- Links to the old file names of 0006, 0010, 0022, 0024 and 0031 break on GitHub, in closed issues and merged PR bodies. Links in the repo and in open issues are updated.
- An audit log written before migration 0003 has rows with the actor kind `agent`. Only development databases can have them, since no release exists. Code that reads the log later treats `agent` as `bot`.
- A developer with an old test config renames `agents.yaml` to `bots.yaml`, and its top-level key `agents:` to `bots:`. Until both are done, the server reports the file as missing or the key as unknown.
- #14 creates the user `aphelion-bot` and the folder `/var/lib/aphelion-bots`.
- The plan's Amendments note says that this record renamed the word without marking each change.
