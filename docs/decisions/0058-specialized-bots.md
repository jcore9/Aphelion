# 0058. Each bot starts with no connectors or plugins, and the owner switches on the ones it may use

- Status: Proposed
- Date: 2026-11-23
- Decided by: project owner
- Proposed by: the M0-19 PR ([#161](https://github.com/jcore9/Aphelion/issues/161))
- Answers: [#161](https://github.com/jcore9/Aphelion/issues/161), the four questions on how specialized bots get their connectors and plugins
- Amends: the plan's Goals, its Bot registry row, and the issue rows for M3-06, M4-02 and M5-13. [0042](0042-plugin-server-and-client-parts.md), because a plugin's one-time grant now sits under a per-bot switch.
- Relies on: [0020](0020-1password-grok-bot-style.md) (1Password grants stay per item, per consumer and per bot), [0042](0042-plugin-server-and-client-parts.md) (a plugin is granted once, for the whole server), [0038](0038-plugin-manifest-and-api-range.md) (the host reads a plugin's contributions from its manifest)

## Context

The owner wants Aphelion to work like Grok Bot: specialized bots, each connecting to different things and running different plugins. One bot works on GitHub. Another handles email and calendars. Each sees only its own connectors and plugins.

The plan has pieces of this. Custom MCP servers can be "enabled for specific bots only", and the policy engine scopes rules per bot, per connector and per tool. The plan never says in one place that a bot has its own list of connectors and plugins. Decision 0042 grants a plugin once, for the whole server, so nothing says how that grant combines with a bot.

Some terms:

- A **connector** is a plugin that connects Aphelion to a service, such as GitHub, and gives bots tools to use it.
- An **MCP server** is a program that offers tools to a bot over a standard protocol. A custom MCP server is one the owner adds.
- The **policy engine** decides whether a bot's action is allowed, needs the reviewer, or needs the owner. Its rules can name a bot, a connector and a tool.
- A **grant** is the permission list the owner approved for a plugin.
- The **manifest** is the plugin's JSON file that says what it needs and what it adds ([the manifest reference](../reference/plugin-manifest.md)).

The owner answered four questions on 2026-11-23. All four took the recommended answer.

## Options

### 1. What a new bot starts with

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Nothing: no connectors, no plugins | owner | A bot can use only what the owner chose for it. A forgotten tick fails safe. | The owner ticks each item for every bot. |
| Everything installed | | No setup. | A new bot can use every connector, so one prompt-injected bot reaches all of them. Contradicts "each sees only its own". |

The create screen shows a checklist of what is installed, with every box unticked. The owner ticks what this bot needs.

### 2. How permissions work per bot

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| One server-wide grant, plus an on/off switch per bot | owner | One approval per plugin, as today. Finer limits already exist in the policy engine. | A plugin that is on for a bot has all of its grant for that bot. |
| A separate grant per bot | | A bot could get less than the plugin's full grant. | Approving the same plugin once per bot, and a second place that says what a bot may do. |

### 3. Reusable bot setups

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Export and import as a file now. Presets shipped in plugins later. | owner | Bots are already YAML in the config directory, so a file costs little. | Plugin-provided presets wait. |
| Files and plugin presets together now | | Everything at once. | Plugin-provided presets need the install flow (M5-13) and a review story that doesn't exist yet. |
| No reuse | | Nothing to build. | The owner retypes a setup for each similar bot. |

### 4. Plugins that serve the whole server

| Option | Picked by | For | Against |
| --- | --- | --- | --- |
| Exempt by what the plugin does, read from its manifest | owner | No new setting to learn or get wrong. The manifest is already the host's one source. | The rule must name the manifest fields that count. |
| An "all bots" checkbox on each plugin | | Explicit. | One more setting per plugin, and a plugin author could mark a tool plugin as exempt. |

## Decision

All four answers are as the owner picked.

### A new bot has nothing

A new bot starts with no connectors and no plugins. The create screen shows what is installed as a checklist with every box unticked. The owner ticks what this bot needs. The owner can change the list later.

### Per-bot permissions

- A plugin's permissions are approved once, for the whole server, as [decision 0042](0042-plugin-server-and-client-parts.md) and [the plugin reference](../reference/plugins.md) say. No per-bot narrowing of a plugin's grant exists.
- Each bot has an on/off switch for each plugin and each connector. The switch answers one question: which bots may use it. A bot that has it off can't see the plugin's tools, and its calls to them are refused.
- Finer control comes from the policy engine. For example, one bot can be read-only on GitHub through a rule scoped to that bot, that connector and those tools.
- 1Password item grants stay per item, per consumer and per bot, as [decision 0020](0020-1password-grok-bot-style.md) says.

A plugin must be approved before a bot can switch it on. The switch never gives a plugin a permission it hasn't been granted.

### Bot presets

A **bot preset** is a file that holds one bot's setup. It names the bot's instructions, provider, model, connectors and plugins. It never holds an approval, a grant or a secret.

- The owner can export a bot to a preset file and import one. Bots are already YAML in the config directory, and a preset uses the same format.
- Importing asks the owner to approve anything missing: a plugin that isn't installed, a permission that isn't granted, a connector that isn't connected. The imported bot gets nothing the owner hasn't approved.
- A preset is not a policy mode preset. The policy engine's modes (Strict, Balanced and the others) set how much a bot's actions are gated. A bot preset sets what a bot is made of. The two never replace each other.
- **Later, not planned now:** presets that a plugin ships inside itself. They wait for a later milestone and have no issue yet.

### Which plugins are on a bot's list

The host decides from the manifest, with no extra setting. The rule:

> A plugin appears on a bot's list when its manifest contributes something a bot calls: a tool, a connector or a custom MCP server. Every other plugin serves the server or the app, is always on, and never appears on a bot's list.

The manifest fields that exist today are `server`, `client`, `permissions.events`, `permissions.secrets`, `permissions.network`, `permissions.uiSlots`, `contributes.secretSchemes` and `contributes.screens`. None of them gives a bot a tool, so today no plugin is on a bot's list. The connector contract (M3-02) adds the contribution that names tools and connectors. This record doesn't invent its field name.

| Kind of plugin | On a bot's list? | Why |
| --- | --- | --- |
| Connector, custom MCP server, any plugin that adds tools | Yes | It gives a bot something to call. |
| Secret backend (`contributes.secretSchemes`) | No | It serves the secrets broker, not a bot. A bot never sees the values it resolves. |
| Theme | No | It changes how the app looks. |
| Notifier | No | It sends notices to the owner. |
| UI plugin, including one that shows bot status (`permissions.uiSlots`, `contributes.screens`) | No | It serves the app. |
| Bot adapter | No | A bot picks its adapter through its `provider` field. The list is for what a bot may call, and an adapter runs the bot itself. |
| Reviewer | No | The policy engine picks the reviewer for each rule. A reviewer sees only an action, never a bot's tools. |
| Routine trigger | No | A routine's definition names its trigger. It starts runs. A bot doesn't call it. |

A plugin that does both, such as a connector with a client part that draws a screen, is on the list, because it contributes a tool.

## Consequences

- The plan's Goals gain a paragraph on specialized bots. Its Bot registry row says a bot also lists its connectors and plugins. The rows for M3-06, M4-02 and M5-13 say what each adds. The plan's text on custom MCP servers already scopes each server to specific bots, and now agrees with the rest.
- [The plugin reference](../reference/plugins.md) gains a short section on how a grant and a bot's switch combine, and which plugins are server-wide.
- M4-02 builds the registry's per-bot lists and the create screen's checklist. M3-06 builds the per-bot switch for custom MCP servers. M5-13 builds the switch for installed plugins, and the install screen shows which bots a new plugin could be turned on for.
- The M0 plan gains M0-19 for this docs work, in wave 1. It depends only on M0-00, and it blocks nothing in M0.
- Cost: a plugin that is on for a bot has its whole grant for that bot. Narrowing by bot depends on the policy engine's rules, which arrive in M2 and are edited in M5-09.
- **Open case: events.** A UI plugin's `permissions.events` grant covers every bot's events. The owner can't give one UI plugin the events of only some bots. Decide this when M5-11 defines which events a client part receives.
- **Open case: a plugin that is both.** A plugin that adds tools and also is a bot adapter would be on the list for its tools, but its adapter role would stay server-wide. Decide this if the first such plugin appears.
- Not decided here: the exact YAML shape of a bot preset, the screen layouts, and how the app shows a plugin that was switched on and later uninstalled. M4-02 and M5-13 settle these.

Revisit this record when:

- The owner asks for a grant that differs per bot.
- A kind of plugin appears that the rule above can't place.
- Presets shipped inside plugins get an issue.
