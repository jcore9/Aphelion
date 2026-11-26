# The Claude adapter

The Claude adapter is the [bot adapter](bot-adapters.md) for bots whose provider is `claude`. It drives Claude Code, the `claude` command, through the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), the library that Anthropic publishes to run Claude Code from a program. It turns what Claude Code does into the events that every adapter emits.

The adapter is part a of [#20](https://github.com/jcore9/Aphelion/issues/20). Part b, [#214](https://github.com/jcore9/Aphelion/issues/214), adds the fixed permission rule. Until then the runtime's default decider denies every tool call.

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

A **query** is one running Claude Code process that the SDK talks to. The adapter starts one query when the bot runner opens the session, and keeps it for every turn. A turn sends the prompt into the running query and reads the SDK's messages until that turn's result.

- When the query has stopped, the next turn starts a new query that resumes the last session id Claude Code reported. The first query resumes the `resume` ref that the bot runner saved, if it has the form of a Claude session id.
- On shutdown, the adapter closes the query's input and waits up to 5 seconds for Claude Code to exit, then aborts it.

## What every query gets

| Option | Value |
| --- | --- |
| `pathToClaudeCodeExecutable` | `/usr/local/bin/claude` |
| `cwd` | The bot's folder |
| `permissionMode` | `default`. The adapter stops a turn whose Claude Code reports another mode. |
| `canUseTool` | Asks the turn's `decide` about each tool call. See [Permissions](#permissions). |
| `tools` | `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `Bash` and `TodoWrite`. The model sees no other tool. |
| `disallowedTools` | `WebFetch`, `WebSearch` and `Agent` |
| `allowedTools` | Never set. A tool on that list runs without asking `canUseTool`. |
| `settingSources` | `[]`, so Claude Code reads no user or project settings files |
| `includePartialMessages` | `true`, so text arrives in small pieces |
| `resume` | The session to resume, when there is one |
| `env` | Built from the allow list below |
| `stderr` | Counts the lines Claude Code writes to its error output, and keeps none of them |
| `executable` | `bun` |

### The environment Claude Code gets

The SDK's `env` option replaces Claude Code's whole environment. The adapter copies only these variables from its own environment: `HOME`, `PATH`, `LANG`, `TZ`, `TMPDIR`, and the proxy variables `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `ALL_PROXY` in upper and lower case. It then sets `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so Claude Code doesn't update itself and runs no command in the background.

No key passes. An `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` in the bot process's environment never reaches Claude Code. Claude Code finds its sign-in in `HOME`. [#181](https://github.com/jcore9/Aphelion/issues/181) adds an API key for a bot that has no sign-in.

## How messages become events

| SDK message | Event |
| --- | --- |
| `system` with subtype `init` | `session`, the first time and again when the id changes |
| A `text_delta` in a `stream_event` | `text.delta`, split into pieces of at most 16 KiB |
| A `tool_use` block in an `assistant` message | `tool.start`, once per call id, with the kind from the table below |
| A `tool_result` block in a `user` message | `tool.end` with `ok`, or `error` when Claude Code marks the result as an error, or `denied` when this turn's `decide` denied that call |
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
| Claude Code reports another permission mode or version than 2.1.330, a result the adapter can't read, or any other failure | `vendor` |

### Tool kinds

| Tool | Kind |
| --- | --- |
| `Read`, `Glob`, `Grep` | `file.read` |
| `Write`, `Edit`, `NotebookEdit` | `file.write` |
| `Bash` | `shell` |
| `WebFetch`, `WebSearch` | `web` |
| Any other tool | `other` |

## Permissions

Claude Code calls the SDK's `canUseTool` hook before it runs a tool that needs a permission. The adapter builds a `PermissionRequest` and passes it to the turn's `decide`:

- `call` is the tool call's id, and `request` is the SDK's request id.
- `paths` holds the strings in the input fields `file_path`, `notebook_path` and `path`, and also `pattern` for `Glob` and `Grep`. A pattern can be an absolute path or hold `..`, so the rule in #214 checks it too.
- `command` is the command of a `shell` tool.
- A path or a command longer than 4096 bytes is cut, and `truncated` is `true`.

The hook allows the call only when `decide` answers `allow`. It answers `allow` with nothing else, so no rule outlives the call. Every other path returns a deny with the fixed message `Aphelion denied this tool call.`: a `deny` answer, a request whose ids don't fit the contract, a hook call outside a turn, a cancel, and an error in `decide`. The hook never returns `null`, which would leave the tool waiting with no deadline.

Claude Code carries on after a deny, so a turn never ends with `denied`. A tool that Claude Code refuses by itself, such as a disallowed tool, ends with `error`, because no decision exists for it.

## Cancel

When the runtime aborts the turn's signal, the adapter asks Claude Code to interrupt and waits up to 3 seconds for the turn's result. Then it ends the turn with `cancelled`, and the query stays open for the next turn. If no result comes in time, the adapter aborts the query and ends the turn with `cancelled`. The next turn then starts a new query that resumes the session. A tool call that waits for a decision is denied.

## Logs

Nothing that Claude Code or the SDK prints reaches an event or a log line. Events carry fixed codes, errors are mapped by their type, and the error output is only counted. A test runs a turn with a fake key in the environment, in Claude Code's error output and in a thrown error, and checks that no event and no log line holds it.

The adapter writes these lines to the log:

- `the Claude CLI stopped: <class>`, where `<class>` is the SDK's error class, such as `process_exited_nonzero`, or `unknown`
- `the Claude CLI didn't start: <class>`
- `the CLI wrote <n> lines to stderr`
- `the CLI didn't start as Claude Code 2.1.330 in default permission mode, so the adapter stopped it`
- `the saved session ref isn't a Claude session id, so the bot starts a new session`

## Record a stream for the replay tests

`scripts/record-claude-stream.ts` runs one real turn through the adapter and saves every SDK message for the replay tests of [#25](https://github.com/jcore9/Aphelion/issues/25). It needs Claude Code 2.1.330 at `/usr/local/bin/claude`, signed in for the user who runs the script. CI never runs it.

```sh
bun scripts/record-claude-stream.ts --name tool-turn
```

The script makes an empty folder in the system's temporary folder and sends a prompt that writes and reads one file there. Its decider allows file tools inside that folder and denies everything else. It prints each event, then writes `packages/claude-adapter/fixtures/tool-turn.jsonl` with one SDK message per line. The folder's path becomes `/work` and the home folder becomes `/home/bot`. It writes no file when the turn doesn't complete or when `checkStream` finds a broken rule. Pass `--prompt` to send another prompt. Read the file before you commit it, because it holds the model's reply and the tool output.

## Checked only by a live run

These points from [decision 0034](../decisions/0034-vendor-protocol-per-cli.md) need a signed-in Claude Code, so CI can't check them:

1. Whether a read inside the bot's folder asks `canUseTool`.
2. Whether `settingSources: []` still loads root-owned managed settings.
3. How Claude Code behaves after a deny.
4. Whether `resume` works after a restart inside the container.
5. Whether `bun install` leaves out the optional packages. The image build uses `--omit=optional`, and the bundle runs with no `node_modules`, which the image contract checks.
