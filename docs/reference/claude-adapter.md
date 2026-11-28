# The Claude adapter

The Claude adapter is the [bot adapter](bot-adapters.md) for bots whose provider is `claude`. It drives Claude Code, the `claude` command, through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), the library that Anthropic publishes to run Claude Code from a program. It turns what Claude Code does into the events that every adapter emits.

The adapter is [#20](https://github.com/jcore9/Aphelion/issues/20). Part a, [#213](https://github.com/jcore9/Aphelion/issues/213), streams a turn. Part b, [#214](https://github.com/jcore9/Aphelion/issues/214), adds the fixed permission rule that [What the first bot may do](#what-the-first-bot-may-do) describes.

## Where it lives

| What | Where |
| --- | --- |
| Source | [`packages/claude-adapter`](https://github.com/jcore9/Aphelion/tree/main/packages/claude-adapter) |
| Manifest | `aphelion-plugin.json`, with `contributes.botAdapter.provider` set to `claude` and the server entry `adapter.js` |
| In the image | `/usr/local/lib/aphelion/adapters/claude/adapter.js` and its manifest, owned by root, mode `0644` |

The image holds the adapter as one bundled file, built with `bun build`. It has no `node_modules` folder, so none of the SDK's optional packages ship. Those packages each hold a copy of Claude Code, and the adapter never uses them. The [image contract](container.md) checks that the folder holds only these two files, that the image has no `node_modules` and no file named `claude` outside `/opt/aphelion/tools`, and that the bundle runs as `aphelion-bot`.

The bot runner ([#22](https://github.com/jcore9/Aphelion/issues/22)) will start the adapter with `bun adapter.js` inside each `claude` bot's process.

## Versions

| Part | Version | How it is held |
| --- | --- | --- |
| Agent SDK | 0.3.330 | Pinned exactly in the package's `package.json` |
| Claude Code | 2.1.330 | The version the SDK was built for. The adapter checks it on every turn. |
| Claude Code's path | `/usr/local/bin/claude` | Set on every query, so the SDK never looks for its own copy |

A test fails when the SDK's own `claudeCodeVersion` differs from the version the adapter expects. Raise the SDK and the Claude Code entry in the tool list ([#155](https://github.com/jcore9/Aphelion/issues/155)) together.

## Sessions and turns

A **query** is one running Claude Code process that the SDK talks to. The adapter starts one query when the bot runner opens the session, and keeps it for every turn. When the owner stored an API key, opening the session first runs the sign-in check that [The environment Claude Code gets](#the-environment-claude-code-gets) describes. No query, and so no tool call, exists until that check ends. A turn sends the prompt into the running query and reads the SDK's messages until that turn's result.

- When the query has stopped, the next turn starts a new query that resumes the last session id Claude Code reported. The first query resumes the `resume` ref that the bot runner saved, if it has the form of a Claude session id.
- On shutdown, the adapter closes the query's input and waits up to 5 seconds for Claude Code to exit, then aborts it.

## What every query gets

| Option | Value |
| --- | --- |
| `pathToClaudeCodeExecutable` | `/usr/local/bin/claude` |
| `cwd` | The bot's folder |
| `permissionMode` | `default`. The adapter stops a turn whose Claude Code reports another mode. |
| `canUseTool` | Asks the turn's `decide` about each tool call. See [Permissions](#permissions). |
| `tools` | `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep` and `Bash`. The model sees no other tool. `TodoWrite` is left out because the rule would deny it. |
| `disallowedTools` | `WebFetch`, `WebSearch`, `Agent` and `Skill` |
| `skills` | `[]`, so the model sees no skill and the `Skill` tool runs none |
| `allowedTools` | Never set. A tool on that list runs without asking `canUseTool`. |
| `hooks` | One `PreToolUse` hook that applies the fixed rule to every tool call, with `onFailure: "block"`. See [The hook](#the-hook). |
| `settingSources` | `[]`, so Claude Code reads no user or project settings files |
| `settings` | Thirteen keys that keep out what the signed-in account and Claude Code would add. See [What the adapter turns off](#what-the-adapter-turns-off). |
| `strictMcpConfig` | `true`, so Claude Code starts only the MCP servers in `mcpServers`. The adapter never sets `mcpServers`, so a bot has no MCP server. |
| `verbatimPrompts` | `true`, so each prompt reaches Claude Code exactly as typed. See [Prompts are passed as typed](#prompts-are-passed-as-typed). |
| `includePartialMessages` | `true`, so text arrives in small pieces |
| `resume` | The session to resume, when there is one |
| `env` | Built from the allow list below. It holds `ANTHROPIC_API_KEY` only when there is no working sign-in. |
| `stderr` | Counts the lines Claude Code writes to its error output, and keeps none of them |
| `executable` | `bun` |

### What the adapter turns off

Claude Code adds tools, skills and plugins from the claude.ai account it is signed in with, even with `settingSources: []`. In the first recorded turn, the session listed 123 tools instead of 7. The extra 116 were the account's claude.ai connectors, such as Notion and Gmail. Those tools act as the owner's account, outside the bot's folder, and their definitions filled most of each request's context.

Under [decision 0058](../decisions/0058-specialized-bots.md), a bot has only the connectors and plugins that Aphelion gives it. So the adapter passes these keys in `settings`. Claude Code reads them as if they came from its `--settings` flag.

| Key | Value | What it stops |
| --- | --- | --- |
| `disableClaudeAiConnectors` | `true` | The account's claude.ai connectors. Claude Code doesn't fetch or connect them. |
| `syncClaudeAiSkills` | `false` | The skills the account enabled on claude.ai |
| `syncClaudeAiPlugins` | `false` | The plugins the account enabled on claude.ai |
| `disableBundledSkills` | `true` | The skills and workflows that ship with Claude Code |
| `disableSkillShellExecution` | `true` | Shell commands written inside a skill or slash command. Claude Code shows a placeholder instead of running them. |
| `autoMemoryEnabled` | `false` | Claude Code's auto memory, which reads and writes notes in a folder under `HOME` and adds them to the prompt |
| `autoDreamEnabled` | `false` | Auto-dream, which tidies the auto memory in the background. It has its own default on Anthropic's side, so turning off auto memory doesn't turn it off. |
| `disableWorkflows` | `true` | Workflows, Claude Code's multi-agent runs |
| `enableWorkflows` | `false` | Workflows again, as the account-level switch |
| `workflowKeywordTriggerEnabled` | `false` | The keyword that turns a prompt into a workflow run |
| `enableArtifact` | `false` | Artifacts, the claude.ai pages Claude Code can publish |
| `crossSessionInbound` | `"refuse"` | Messages from the account's other Claude Code sessions. Without it, a message from another session in the same permission mode reaches the bot. |
| `autoUploadSessions` | `false` | A copy of each session on claude.ai |

Each key is in the SDK's `Settings` type at version 0.3.330 with the meaning above. A test checks that the adapter passes all thirteen.

Claude Code also loads its built-in plugins, whose path is `builtin` and whose name starts with `cc-plugin-`. The SDK documents no setting that turns them off from `--settings`, so they stay.

The adapter then checks every `init` message the session sends. Claude Code sends one at the start of each turn, and may send another when the session changes, even between turns. The adapter stops the query when an `init` lists any of these:

- a tool other than the seven in `tools`
- any MCP server
- a plugin unless its path is `builtin` and its name starts with `cc-plugin-`

An `init` that has no `tools`, `mcp_servers` or `plugins` list, or a plugin with no name, is stopped the same way. When a turn is running, it ends with `error` (`vendor`). When no turn is running, the next turn starts a new query. The log line gives the counts and no names.

Trust lasts one turn. Each turn starts unchecked, and every tool call waits until the adapter has checked that turn's `init`. A call whose `init` fails is denied. A call also stops waiting, and is denied, when Claude Code cancels it. A call that comes when no turn is running, or after shutdown starts, is denied. A call is also denied when its turn ends before the rule answers, or before that turn's `init` is checked, even when the next turn's `init` is clean. Once the adapter has stopped a query, it denies every later call from that query, including one that was already waiting for the rule.

### Skills

The adapter passes `skills: []` and disallows the `Skill` tool, so the model sees no skill and can't run one. A skill's files can still be on disk, where `Read` and `Bash` can reach them.

The `init` also lists skill names. The adapter logs how many there are, with no names, but doesn't stop a session that lists any. Whether a bot's `init` lists none with these settings is a live check: the owner's next recording settles it. Once that recording shows an empty list, the adapter can stop a session that lists a skill.

### Prompts are passed as typed

Claude Code normally treats some prompt text as instructions to itself. A prompt that starts with `/` runs a slash command, and `@path` attaches that file to the prompt. Both happen inside Claude Code before any tool call, so Aphelion never sees a permission request for them. A slash command such as `/add-dir` could widen the folders Claude Code may read, and an `@` mention reads a file without asking.

With `verbatimPrompts` set, Claude Code sends the prompt to the model as plain text. `/commands` and `@file` mentions don't work in a bot.

The cost: Claude Code also skips the context it would normally attach at the start of a turn, such as the `CLAUDE.md` files it finds in the folder tree. It attaches most of that context after the turn's first tool call instead.

### The environment Claude Code gets

The SDK's `env` option replaces Claude Code's whole environment. The adapter copies only these variables from its own environment: `HOME`, `PATH`, `LANG`, `TZ`, `TMPDIR`, and the proxy variables `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `ALL_PROXY` in upper and lower case. It then sets `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so Claude Code doesn't update itself and runs no command in the background.

An `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in the adapter's environment never reaches Claude Code. Claude Code finds its sign-in in `HOME`.

`ANTHROPIC_API_KEY` reaches Claude Code only when there is no working sign-in. The supervisor sets it in the adapter's environment when the owner stored a Claude API key ([the API key at start](bot-runner.md#the-api-key-at-start)). Claude Code uses an `ANTHROPIC_API_KEY` ahead of its sign-in, so the adapter checks the sign-in first. Before its first query, it runs `claude auth status` once, with the variables above and without the key, a 5-second limit, and its output thrown away. It runs the check from `/`, not from the bot's folder, so a `.claude/settings.json` in that folder, such as one with an `apiKeyHelper`, can't make the check pass. Turns read no settings files, so such a check would keep the key out of turns that then fail to sign in. Exit status 0 means a working sign-in. The adapter then leaves the key out of every query's environment, and the subscription pays. Exit status 1, a missing CLI, or no answer within 5 seconds means no working sign-in, and the adapter passes the key. Without a key, the adapter runs no check. The key changes nothing about which tool calls run: each turn still starts unchecked, and its `init` check works the same with or without the key.

`claudeEnv` in `packages/claude-adapter/src/options.ts` makes that choice, and `sessionEnv` in `packages/claude-adapter/src/sign-in.ts` runs the check. The check runs once per adapter process, so a sign-in that stops working brings the key in only at the next adapter start, such as after a cancel or a bot restart. Whether `claude auth status` reports an expired sign-in as signed out isn't measured yet. The owner's live check with a throwaway key covers it.

## How messages become events

| SDK message | Event |
| --- | --- |
| `system` with subtype `init` | `session`, the first time and again when the id changes. An `init` with another permission mode or Claude Code version, or one with no readable mode or version, stops the query and ends the turn with `error` (`vendor`). So does an `init` that lists more than the adapter gave the session, as [What the adapter turns off](#what-the-adapter-turns-off) describes. The adapter checks an `init` that arrives between turns too. |
| A `text_delta` in a `stream_event` | `text.delta`, split into pieces of at most 16 KiB |
| A `tool_use` block in an `assistant` message | `tool.start`, once per call id, with the kind from the table below |
| A `tool_result` block in a `user` message | `tool.end` with `ok`, or `error` when Claude Code marks the result as an error, or `denied` when this turn's `decide` denied that call and the runtime announced the deny with a `permission.decision` event |
| `result` with subtype `success` | `usage`, then `turn.end` with `completed`, or `refused` when the stop reason is `refusal` |
| `result` that hit a limit: `error_max_turns`, `error_max_budget_usd`, or the end reason `max_turns`, `budget_exhausted`, `blocking_limit` or `prompt_too_long` | `usage`, then `turn.end` with `limit` |
| `result` with the end reason `aborted_streaming` or `aborted_tools` after a cancel | `turn.end` with `cancelled` |
| Any other `result` | `error`, then `turn.end` with `error` |
| An `assistant` message with an error, an `auth_status` message with an error, or a rejected `rate_limit_event` | `error` |
| Every other message | None |

The adapter drops a message from a sub-agent, which has a `parent_tool_use_id`, and a replayed `user` message. A turn has at most one `error` event, and the first code wins.

`usage` counts the tokens of the turn's result. Claude Code reports cost as a running total for the query, so `costUsd` is the change since the last result. It is `null` for the first turn after a resume from a saved ref, because the earlier total isn't known.

### Error codes

| Cause | `error` code |
| --- | --- |
| `/usr/local/bin/claude` is missing or doesn't start | `cli-not-found` |
| Claude Code exits or the SDK throws during a turn | `cli-exited` |
| A sign-in problem: the assistant error `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold` or `verification_required`, an `auth_status` error, or status 401 | `signed-out` |
| A rate limit: the assistant error `rate_limit` or `billing_error`, a rejected `rate_limit_event`, or status 429 | `rate-limited` |
| Claude Code reports another permission mode or version than 2.1.330, a tool, MCP server or plugin that Aphelion didn't give it, a result the adapter can't read, or any other failure | `vendor` |

### Tool kinds

| Tool | Kind |
| --- | --- |
| `Read`, `Glob`, `Grep` | `file.read` |
| `Write`, `Edit`, `NotebookEdit` | `file.write` |
| `Bash` | `shell` |
| `WebFetch`, `WebSearch` | `web` |
| Any other tool | `other` |

## What the first bot may do

Until M2 adds the owner's yes or no, every Claude bot gets the same fixed answer to each tool call ([decision 0063](../decisions/0063-m1-planning-answers.md)). The code is `folderRule` in the plugin SDK. It never learns and never widens.

| The bot asks to | Answer | Reason code |
| --- | --- | --- |
| Read or search files inside its folder (`Read`, `Glob`, `Grep`) | Allowed | `inside-folder` |
| Change files inside its folder (`Write`, `Edit`, `NotebookEdit`) | Allowed | `inside-folder` |
| Read, search or change a file outside its folder | Denied | `outside-folder` |
| Fetch a web page or search the web (`WebFetch`, `WebSearch`) | Denied | `web` |
| Run a shell command (`Bash`) | Allowed, whatever the command says | `shell` |
| Use any other tool | Denied | `unknown-tool` |

How "inside" is judged:

- A relative path counts from the bot's folder. `..` is applied, so `../other/x` is outside.
- Every link is followed. A link inside the folder that points outside counts as outside, and so does a broken link, because writing to it would create its target.
- A file that doesn't exist yet is judged by the nearest folder above it that does.
- A search pattern such as `src/**/*.ts` is judged by its part before the first wildcard. `/etc/*` and `../*` are outside. A pattern with `..` after a wildcard, a `\`, or a choice in `{…}` or `@(…|…)` that starts with `/` or `~` is denied.
- A path that starts with `~` is denied, because Claude Code reads it as the home folder.
- Every path in the request must be inside. A request with no path, or with a path that was cut at 4096 bytes, is denied.
- A path the disk can't resolve, for example one the bot may not read, is denied.

Each answer covers that one call. The adapter never hands back the session-wide rule or mode change that Claude Code suggests.

**The limit, stated plainly.** Aphelion can't read what a shell command does. Only the file permissions of the `aphelion-bot` account and the container hold a shell command. A command can read other bots' folders and reach the internet, so `cat /etc/passwd` or `curl` in `Bash` runs even though a `Read` of the same file or a `WebFetch` is denied. The container still keeps it from Aphelion's secrets and config. Only one bot exists in M1, and M1 uses test data only. M2 puts each command behind the owner's yes or no. A bot can also read its own sign-in token or API key, so a tricked bot could leak it.

**A guard rail, not a wall.** The file-tool rule keeps the model's file tools in the bot's folder. It doesn't stop a bot that means to leave. Shell commands are allowed ([decision 0063](../decisions/0063-m1-planning-answers.md)), so a bot can read outside its folder with a shell command. It can also change a file in the moment between Aphelion's check and Claude Code opening the file, or plant a link that a search then follows, because the rule judges the search pattern, not each file the search finds. Each of those needs a shell command, and that command could read the outside file directly. One case needs no shell command: a link that is already in the bot's folder and points outside it. A search such as `**/*.ts` can follow it, so don't put such a link in a bot's folder. A wall needs the operating system, such as a separate account for each bot, which later milestones bring.

## Permissions

Claude Code calls the SDK's `canUseTool` callback before it runs a tool that needs a permission. The adapter builds a `PermissionRequest` and passes it to the turn's `decide`. In a real bot the runtime answers with the fixed rule:

- `call` is the tool call's id, and `request` is the SDK's request id.
- `paths` holds the strings in the input fields `file_path`, `notebook_path` and `path`. For `Glob` it holds `path` and `pattern`, and for `Grep` it holds `path`. A search with no `path` adds `.`, the bot's folder. `Grep`'s `pattern` is a regular expression for the file contents, not a path, so the rule doesn't judge it.
- `Grep`'s `glob` is a filter on file names under the search folder, such as `*.ts`, not a path. It goes into `paths`, and so gets judged, only when it could name a place outside that folder: it starts with `/` or `~`, has a part that is exactly `..` (such as `../*.ts`), or has a choice in `{…}` or `@(…|…)` that does. So `*..*.ts` and `**/*.ts` are allowed, and `../*.ts`, `/etc/*` and `{a,../b}/*` are denied.
- `command` is the command of a `shell` tool.
- A path or a command longer than 4096 bytes is cut, and `truncated` is `true`.

Before it asks, the adapter denies a call for a tool other than the seven in `tools`, and a call that an MCP server serves, which the SDK marks with `mcpServer`. Those calls get no `permission.request` event, so they end with `error`.

The hook allows the call only when `decide` answers `allow`. It answers `allow` with nothing else, so no rule outlives the call. Every other path returns a deny with the fixed message `Aphelion denied this tool call.`: a `deny` answer, a request whose ids don't fit the contract, a hook call outside a turn, a cancel, and an error in `decide`. The hook never returns `null`, which would leave the tool waiting with no deadline.

Claude Code carries on after a deny, so a turn never ends with `denied`. A tool that Claude Code refuses by itself, such as a disallowed tool, ends with `error`, because no decision exists for it.

### The hook

Claude Code may run a read-only tool, such as a `Read` inside its working folder, without asking `canUseTool`. So the adapter also registers a `PreToolUse` hook, which Claude Code runs before every tool call. The hook builds the same `PermissionRequest` and asks the same rule.

- A call for a tool other than the seven, or one that an MCP server serves (`mcp_server` in the hook's input), is denied without asking the rule.
- When the rule denies, the hook answers `permissionDecision: "deny"` with the same fixed message, and the tool doesn't run.
- When the rule allows, the hook answers nothing, so Claude Code goes on to ask `canUseTool` when it would. The hook never answers `allow`, because that would skip `canUseTool`.
- An input the hook can't read, or a failure in the rule, is a deny. The matcher also sets `onFailure: "block"`, so a hook that throws blocks the call.

The hook sends no event. A call it stops ends with `error`. A call that also reaches `canUseTool` gets its `permission.request` and `permission.decision` events from there.

## Cancel

When the runtime aborts the turn's signal, the adapter asks Claude Code to interrupt and waits up to 3 seconds for the turn's result. Then it ends the turn with `cancelled`, and the query stays open for the next turn. If no result comes in time, the adapter aborts the query and ends the turn with `cancelled`. The next turn then starts a new query that resumes the session. A tool call that waits for a decision is denied, and the runtime announces that deny, so the call ends with `denied`. A tool call that asks after the cancel is denied without an announcement, so it ends with `error`.

## Logs

Nothing that Claude Code or the SDK prints reaches an event or a log line. Events carry fixed codes, errors are mapped by their type, and the error output is only counted. A test runs a turn with a fake key in the environment, in Claude Code's error output and in a thrown error, and checks that no event and no log line holds it. Another passes the key to a session whose `init` the adapter stops, and checks that the log line holds no key.

The adapter writes these lines to the log:

- `the Claude CLI stopped: <class>`, where `<class>` is the SDK's error class, such as `process_exited_nonzero`, or `unknown`
- `the Claude CLI didn't start: <class>`
- `the CLI wrote <n> lines to stderr`
- `the CLI didn't start as Claude Code 2.1.330 in default permission mode, so the adapter stopped it`
- `the session reported <n> tools, <n> MCP servers and <n> plugins that Aphelion didn't give it, so the adapter stopped it`
- `the session reported <n> skills`, only when `init` lists at least one
- `the saved session ref isn't a Claude session id, so the bot starts a new session`

## Record a stream for the replay tests

`scripts/record-claude-stream.ts` runs one real turn through the adapter and saves every SDK message for the replay tests of [#25](https://github.com/jcore9/Aphelion/issues/25). It needs Claude Code 2.1.330 at `/usr/local/bin/claude`, signed in for the user who runs the script. CI never runs it.

```sh
bun scripts/record-claude-stream.ts --name tool-turn
```

The script makes an empty folder in the system's temporary folder and sends a prompt that writes and reads one file there. It sends that folder in `initialize` and answers with the fixed rule. It prints each event, then writes `packages/claude-adapter/fixtures/tool-turn.jsonl` with one SDK message per line. The folder's path becomes `/work` and the home folder becomes `/home/bot`. It writes no file when the turn doesn't complete or when `checkStream` finds a broken rule. Pass `--prompt` to send another prompt. Read the file before you commit it, because it holds the model's reply and the tool output.

## Decision 0034's open points

[Decision 0034](../decisions/0034-vendor-protocol-per-cli.md) left these points open. The code and the SDK's types settle part of each. The rest needs a signed-in Claude Code, so CI can't check it.

1. **Does a read inside the bot's folder ask `canUseTool`?** The code doesn't depend on the answer. The `PreToolUse` hook applies the rule to every call, whether it asks or not. A live run should still record whether it asks.
2. **What does the SDK do with no `permissionMode`?** The SDK's types say Claude Code then picks the mode from the settings it loads, else `auto` where that mode exists. The adapter never leaves it out: it always passes `default`, and stops a turn whose `init` reports another mode.
3. **Does `settingSources: []` still load root-owned managed settings?** The image ships Claude Code's managed settings file at `/etc/claude-code/managed-settings.json`, owned by root with mode `0644`, so `aphelion-bot` can read it but not change it. It sets `permissions.disableBypassPermissionsMode` and `permissions.disableAutoMode` to `"disable"`, which turn off the `bypassPermissions` and `auto` modes. The SDK's types say `settingSources: []` skips only the user, project and local files and still reads the managed file from disk. Whether Claude Code 2.1.330 really does is a live check for the owner. The adapter doesn't depend on it: it always passes `default`, and stops Claude Code if an `init` reports any other mode.
4. **How do deny answers behave?** The adapter's deny carries only the fixed message, with no `interrupt`, so Claude Code should carry on with the turn. The hook's deny uses the SDK's `permissionDecision: "deny"`. A live run should check that Claude Code carries on after each, and what its `tool_result` looks like.
5. **Does `resume` work after a restart inside the container?** Not settled. It needs a live run as `aphelion-bot`.
6. **Does `bun install` leave out the optional packages?** The image build uses `--omit=optional`, and the bundle runs with no `node_modules`, which the image contract checks.
