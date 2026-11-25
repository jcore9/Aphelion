# 0065. The bot adapter runs inside the bot, not under the plugin runner

- Status: Proposed
- Date: 2026-11-25
- Decided by: project owner
- Proposed by: the #19 trace for the M1 plan, in the PR that adds this record
- Answers: who runs the bot adapter, and as which user, so [#19](https://github.com/jcore9/Aphelion/issues/19), [#20](https://github.com/jcore9/Aphelion/issues/20) and [#22](https://github.com/jcore9/Aphelion/issues/22) build on one base
- Amends: the [M1 plan](../plan/milestones/M1-one-bot-end-to-end.md) sections for #19 and #20, and the [plan](../plan/aphelion-plan.md) table that lists bot adapters as server plugins

## Context

A **bot adapter** is the code that drives one AI tool, such as `claude`, and turns what the tool does into a fixed set of events: text, tool use, permission requests, the end of a turn, errors and usage. [#19](https://github.com/jcore9/Aphelion/issues/19) defines that contract. [#20](https://github.com/jcore9/Aphelion/issues/20) builds the Claude adapter. Neither says which process runs the adapter.

The plan points two ways:

- The M1 plan calls #19 "the plugin interface", and the plan's plugin table lists bot adapters as server plugins. The plugin runner starts server plugins as the `aphelion-plugins` user, one process per plugin ([decision 0018](0018-shared-plugin-user.md)).
- Bots must run as the `aphelion-bot` user, so they can read and write bot folders ([decision 0006](0006-shared-bot-user.md)). The `aphelion-plugins` user can't open a bot's folder ([decision 0018](0018-shared-plugin-user.md)). Bot network access goes only through the proxy settings ([decision 0022](0022-bot-network-boundary.md)). The bot runner, which #22 builds, starts one process per bot as `aphelion-bot`.
- [Decision 0058](0058-specialized-bots.md) says an adapter is not on a bot's plugin list. The bot's `provider` field picks it.

The `claude` program must run as `aphelion-bot` with the bot's folder as its working folder. An adapter that runs under the plugin runner would start `claude` as `aphelion-plugins`, which can't open that folder.

The owner chose on 2026-11-25.

## Options

1. **The adapter runs inside the bot.** The bot runner starts one process per bot as `aphelion-bot`, and the adapter code runs in that process.
2. **The adapter runs under the plugin runner.** It is a normal server plugin and runs as `aphelion-plugins`.

| | Inside the bot | Under the plugin runner |
| --- | --- | --- |
| User that runs `claude` | `aphelion-bot`, as 0006 and 0018 require | `aphelion-plugins`, which can't read a bot's folder |
| Fit with the plugin wire | The adapter doesn't use it | One plugin wire carries everything, but it has no way to send a prompt to one bot or return events, so #19 would extend it |
| Fit with existing decisions | Keeps 0006, 0018, 0022 and 0058 | Needs a change to 0006 and 0018, so the plugin user could open bot folders |
| Secrets | The bot runner hands a key to the CLI at start | A key would pass through the plugin host, which 0042 forbids |
| Cost | Two start paths: the plugin runner for plugins, the bot runner for adapters. #20 needs a stand-in for the bot runner, because #22 lands after it. | The plugin runner and wire need new work before any adapter runs |

## Decision

Option 1. The bot adapter runs inside the bot.

The bot runner (#22) starts one process per bot under `aphelion-bot`, and the adapter code runs inside that process. The adapter is packaged, installed and versioned like a plugin. The plugin runner never runs it, and it is never on a bot's plugin list ([decision 0058](0058-specialized-bots.md)).

Option 2 would reverse 0006 and 0018: the plugin user would need access to bot folders, which removes the line those two records draw between plugins and bots.

## Consequences

- `claude` and the other bot CLIs run as `aphelion-bot`, with the bot's folder and the proxy settings, as [0006](0006-shared-bot-user.md) and [0022](0022-bot-network-boundary.md) require.
- The adapter talks to the server through the bot runner's message channel, not the plugin JSON-RPC wire, so #19 doesn't extend the plugin wire with an outbound event method.
- #19 defines the adapter interface and the event schemas, and #20 builds and tests the Claude adapter against a stand-in for the bot runner, because #22 lands after it.
- The adapter is installed and versioned like a plugin, through a manifest declaration that #19 names, and the plugin runner skips it.
- Credentials ([#181](https://github.com/jcore9/Aphelion/issues/181)) reach the CLI from the bot runner at start, never through the plugin host, so [0042](0042-plugin-server-and-client-parts.md) holds.
- This record leaves the event shapes to #19.
- The M1 plan's #19 and #20 sections and the plan's plugin table change in the same PR and point here.

Revisit this record if a future milestone needs a bot adapter that isn't tied to one bot's process.
