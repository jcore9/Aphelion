# Bot adapters

A **bot adapter** is the code that drives one AI tool, such as `claude`, for one bot. It turns what the tool does into a fixed set of events. Every tool's adapter emits the same events, so the rest of Aphelion doesn't care which tool a bot uses. [Decision 0065](../decisions/0065-bot-adapter-runs-inside-the-bot.md) says where an adapter runs, and [decision 0034](../decisions/0034-vendor-protocol-per-cli.md) says each tool keeps its own protocol.

This page is the contract. It covers what an adapter yields, the rules a stream of events follows, and the wire between an adapter and the bot runner. The SDK exports everything here from `@aphelion/plugin-sdk`, `@aphelion/plugin-sdk/stdio` and `@aphelion/plugin-sdk/testing`. [The plugin API reference](plugin-api.md) lists each type and function.

## What exists today

- The SDK has the contract (`BotAdapter`), the runtime that wraps an adapter (`runAdapter` and `mainAdapter`), and test tools (`fakeAdapter`, `runTurn` and `checkStream`).
- The [bot runner](bot-runner.md) starts one process per bot as the `aphelion-bot` user, and talks to the adapter inside it over [the wire](#the-wire). In an adapter's own tests, `runTurn` plays the bot runner.
- No real adapter exists yet. The Claude adapter is [#20](https://github.com/jcore9/Aphelion/issues/20).

## Where an adapter runs

An adapter runs inside the bot's own process, as `aphelion-bot`, with the bot's folder as the tool's working folder. It doesn't run under the plugin runner and doesn't use the plugin wire. The adapter and the bot runner talk over the adapter process's standard input and output, one JSON message per line, as [the wire](#the-wire) says.

The adapter does one thing, which is to translate its tool's output. The SDK's runtime does everything that must be the same for every tool: it numbers the events, runs one turn at a time, cancels a turn, handles permission requests, and checks every event.

## The adapter interface

An adapter is an object with a `provider` name and an `open` function. `open` returns a session. The session's `turn` function takes one prompt and yields that turn's events.

```ts
import type { BotAdapter } from "@aphelion/plugin-sdk";
import { mainAdapter } from "@aphelion/plugin-sdk/stdio";
```

```ts
interface BotAdapter {
	readonly provider: string;
	open(context: AdapterContext): MaybePromise<AdapterSession>;
}

interface AdapterSession {
	turn(input: TurnInput, signal: AbortSignal): AsyncIterable<AdapterEvent>;
	close?(): MaybePromise<void>;
}
```

`provider` matches the bot's `provider` field and the manifest's `contributes.botAdapter.provider`. Pass the adapter to `mainAdapter`, which runs it on standard input and output, the way `main` runs a plugin.

`AdapterContext` has the bot's `id`, the working `folder`, the vendor session to `resume` (or `null`), and a `log` function.

Each call to `turn` gets a `TurnInput` with the turn's `id`, the prompt `text`, and `decide`. `decide` belongs to that one turn. It asks whether a tool may run. The adapter calls it from its tool's permission hook, such as the `canUseTool` hook of Claude, and must use the `decide` of the turn the hook belongs to. The runtime reports the request and the answer, so an adapter can't forget to report a permission, and can't report one that wasn't asked.

A turn that has ended, was cancelled, or sits in a process that is shutting down is denied at once, with no event. A stale turn can't get an answer that is credited to a newer turn.

## Events

The adapter yields **events**. Each is a small object whose `type` says what happened. The runtime adds a number (`seq`) and the turn's id, checks the event with Zod, and sends it. An event that fails its check ends the turn.

No event has a field that can hold a command, a path or free text, except the text of `text.delta`. A tool name has at most 128 letters, digits and `_.:-`. Everything else is an id, a number, a flag or a fixed code.

| Event | Fields | Notes |
| --- | --- | --- |
| `session` | `ref` | The tool's own session id. Sent when the tool names its session, and again when the id changes. The last one wins. The server saves it, so the bot can resume. |
| `text.delta` | `text` | A piece of the reply, 1 byte to 16 KiB. The adapter splits longer text. The runtime drops an empty one without a word. |
| `tool.start` | `call`, `tool`, `kind` | A tool call began. There is no tool input. `kind` is `file.read`, `file.write`, `shell`, `web` or `other`. A tool the adapter doesn't know is `other`. |
| `tool.end` | `call`, `outcome` | The call ended with `ok`, `error`, `denied` or `cancelled`. There is no tool output. It may come after its turn ended, for a call that keeps running, such as a background command. |
| `permission.request` | `request`, `call`, `tool`, `kind`, `pathCount`, `hasCommand` | The runtime sends it, not the adapter. `call` is `null` when the tool asks before it announces the call. The paths and the command stay in memory and never go into an event. |
| `permission.decision` | `request`, `decision`, `by`, `reason` | The runtime sends it. `decision` is `allow` or `deny`. `by` is `rule`, `policy`, `owner` or `default`. `reason` is one of a fixed list of codes, never text: `inside-folder`, `outside-folder`, `web`, `shell`, `unknown-tool`, `cancelled`, `turn-ended`, `timeout`, `shutdown`, `no-decider`, `invalid-request`, `duplicate-request`, `invalid-decision` or `decider-failed`. A new code raises the minor version. |
| `usage` | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd` | At most once per turn. `costUsd` is `null` when the tool gives no cost. |
| `error` | `code` | One of `cli-not-found`, `cli-exited`, `signed-out`, `rate-limited`, `vendor` or `adapter`. There is no message, so nothing the tool printed or the user typed can ride along. A client turns the code into text. |
| `turn.end` | `reason` | Exactly once per turn. `completed`, `cancelled` (a user's cancel, or a shutdown), `denied` (the tool ended the turn because a permission was refused), `limit`, `refused` or `error`. |

### On the wire

Every event travels as `{ seq, turn, event }`.

- `seq` counts up from 1 for each process, and starts again with a new process.
- `turn` is the turn's id. It is `null` only for `session` and for an `error` outside a turn. Such an event can sit between the events of a turn.

### Ids

| Id | Picked by | Form |
| --- | --- | --- |
| Turn id | The bot runner | 1 to 64 letters, digits, `_` or `-` |
| Tool call id | The adapter, usually the tool's own id | 1 to 128 letters, digits, `_`, `.`, `:` or `-` |
| Permission request id | The adapter | The same form as a tool call id |
| Session ref | The tool | 1 to 256 printable ASCII characters, with no space and no `/`. It is opaque. Tools use UUID-like ids. |

Tool call ids are unique for the whole process, not only for one turn. A tool call id, a request id and a tool name come from the tool or from the bot runner, never from what a user typed, and a set of allowed characters can't prove where a value came from. So the SDK limits the length and the characters, and relies on the adapter to pass only the tool's own ids and names. The same holds for a session `ref`: the SDK refuses spaces and `/`, but a value such as `notes.txt` still passes, so an adapter checks a saved `ref` against its tool's own id format before it resumes with it.

The SDK types each id as a **branded** string. A branded string is a string that TypeScript won't mix up with another kind of string, so a turn id can't pass as a call id. Make one with the matching schema, such as `toolCallId.parse(vendorId)`.

## The permission request

The adapter builds a `PermissionRequest` and passes it to the turn's `decide`. It has the `request` id, the `call` id (or `null`), the `tool`, the `kind`, `paths` (at most 32, each at most 4096 bytes), `command` (at most 4 KiB, or `null`) and `truncated`. Set `truncated` when you cut a path list or a command to fit.

`decide` always resolves with a `PermissionDecision`: `{ decision, by, reason }`. A grant covers that one request only. There is no "allow for the rest of the session" ([decision 0034](../decisions/0034-vendor-protocol-per-cli.md)).

A **decider** is the function that answers. You give one to `runAdapter` in its options.

- `denyAll` is the default. It denies every request, with `by: "default"` and reason `no-decider`.
- M1 adds a fixed rule ([#20](https://github.com/jcore9/Aphelion/issues/20) and [decision 0063](../decisions/0063-m1-planning-answers.md)). It reads `kind` and `paths`, so it works for every tool.
- M2 replaces it with a decider that asks the policy engine over the wire. The adapter code stays the same.

## Rules a stream follows

`checkStream(events)` from `@aphelion/plugin-sdk/testing` checks the events of one process against these seven rules. It checks each event with the same schema the runtime uses, so a caller needn't check first. An event that fails the schema is reported as rule 0. It returns the broken rules, and an empty list when the stream is good. The runtime enforces the ones it can. Tests run a fake adapter's output and the replays of [#25](https://github.com/jcore9/Aphelion/issues/25) through the same function.

1. `seq` counts up by 1 from 1 across the process.
2. An event with a turn id belongs to that turn. An event with `turn: null` may appear anywhere.
3. Each turn has exactly one `turn.end`. After it, the turn's id appears only on `tool.end` events for calls that turn started.
4. Each call id has at most one `tool.start` in the whole process, and at most one `tool.end`, at any later point. A `tool.end` needs a `tool.start` before it. A call with no end is still running.
5. Each `permission.request` has exactly one `permission.decision`, before its turn's `turn.end`.
6. A `tool.end` with outcome `denied` follows a `deny` decision earlier in the turn that started the call, for that call or with `call: null`. The runtime forwards such an end only when it holds.
7. A turn has at most one `usage`.

The order of `tool.start` and its permission request isn't fixed. Claude announces the tool before it asks. Other tools ask first. A denied tool may end the turn (Grok ends it with `denied`) or not (Claude continues). A client must not assume either.

## What the runtime does

- **One turn at a time.** A `turn.start` while a turn runs fails with the JSON-RPC error `-32004 Operation in progress` (`busy`). A repeat of the running turn's own `turn.start` gets the same accept and runs nothing.
- **A finished turn doesn't run again.** A `turn.start` with the id of a turn that already ended fails with the JSON-RPC error `-32005 Turn already ended` (`turnEnded`), even while another turn runs. The bot runner reports it to the server as `ended`. The runtime remembers the ids of the last 1,024 turns it started. An older id would run as a new turn, but that can't happen: the server makes a fresh turn id for each prompt and never reuses one.
- **A broken adapter ends the turn.** The runtime sends `error` with code `adapter`, then `turn.end` with reason `error`, and aborts the adapter's signal. That happens when the stream throws, ends without `turn.end`, yields an event that fails its schema, yields `permission.request` or `permission.decision` itself, yields a second `usage`, starts a call id twice, ends a call that isn't running, or ends a call as `denied` when no deny decision covers it.
- **Each permission request settles exactly once.** The runtime tracks every `decide` call. It denies each open request, with `by: "default"`, when the turn is cancelled, when the turn ends, when the process shuts down, and when the decider's deadline passes. It sends those decisions before `turn.end`, and ignores any later answer. A late `allow` can never run a tool after the client heard that the turn ended.
- **A request that can't be asked is denied without an event.** That covers a request that isn't valid, a request from a turn that ended or was cancelled, a request once shutdown has begun, a repeated request id, and a request for a call that an earlier turn started. No `permission.request` was sent, so no decision follows.
- **Cancel.** `turn.cancel` settles the open requests as `deny`, then aborts the adapter's signal. The adapter should stop its work and may yield its own `turn.end`, usually `cancelled`. If the stream hasn't ended 5 seconds later, the runtime sends `turn.end` with reason `cancelled` itself, and drops the stream's later events, except `tool.end` for calls the turn started. A stream that ends or throws after a cancel counts as `cancelled`, not as an error. Killing the process tree is the bot runner's job.
- **The runtime never makes up a `tool.end`.** A call that the tool leaves running, such as a background command, stays open until the tool ends it or the process ends. The adapter yields that `tool.end` from the same stream or from a later turn's stream, and the runtime stamps it with the turn that started the call.

## The wire

The bot runner and the adapter exchange JSON-RPC 2.0 messages, one JSON object per line. Each line is at most 1 MiB, the same limit as [the plugin wire](plugins.md#talking-to-the-host).

| Direction | Message | Params | Result |
| --- | --- | --- | --- |
| Runner to adapter | `initialize` request | `api`, `bot: { id }`, `folder`, `resume` | `{ api, provider }` |
| Runner to adapter | `turn.start` request | `turn`, `text` (at most 256 KiB) | `{}`, once the turn is accepted and not when it ends |
| Runner to adapter | `turn.cancel` request | `turn` | `{}` |
| Runner to adapter | `shutdown` request | none | `{}`, after the session's `close` |
| Adapter to runner | `event` notification | `seq`, `turn`, `event` | none |
| Adapter to runner | `permission.ask` request | `turn`, `request` | A `PermissionDecision`. The name is reserved for M2, and the runtime doesn't send it. |

The bot runner refuses a prompt longer than 256 KiB, or one whose encoded line is longer than 1 MiB, before it sends it.

If `open` fails, the runtime answers `initialize` with the error `Operation failed` and stops. On `shutdown` or when the input closes, the runtime first marks itself as closing, so new requests are denied at once with reason `shutdown` and no event. It then aborts the running turn, sends the `permission.decision` for each open request, sends one `turn.end` with reason `cancelled` for a turn that is open, and calls `close`. Calls that are still open get no `tool.end`, which rule 4 allows.

On each start, the bot runner sends `resume` with the session that the bot's last `session` event named, if the bot's folder is still the same. If the adapter refuses `initialize` while it resumes, the server forgets that session and starts the bot once more with `resume: null`. An adapter that can't resume a session answers `initialize` with an error, so the bot doesn't loop on a session that is gone. See [Restart and resume](bot-runner.md#restart-and-resume).

When the connection is lost and the runtime can't flush, the bot runner repairs the stream instead. It appends `error` with code `cli-exited`, a `permission.decision` with `deny`, `by: "default"` and reason `shutdown` for each request that has no decision yet, a `tool.end` with outcome `cancelled` for each open call, and `turn.end` with reason `error`. The repaired stream then passes `checkStream`.

## Declare an adapter in a manifest

A package that holds an adapter says so in `aphelion-plugin.json`:

```json
{
	"id": "claude-adapter",
	"version": "1.0.0",
	"api": "^0.2.3",
	"server": { "entry": "dist/adapter.js" },
	"contributes": { "botAdapter": { "provider": "claude" } }
}
```

`provider` has the same form as a plugin `id`. A manifest with `botAdapter` needs a server part. It can't have a client part, other contributions or permissions, and the parser refuses one that does. The plugin runner doesn't start a package that has `botAdapter`, because the bot runner loads it into each bot of that provider. See [the manifest reference](plugin-manifest.md).

## Test an adapter

`@aphelion/plugin-sdk/testing` has what an adapter's tests need.

- `fakeAdapter(script)` is an adapter that runs a script. Each turn is a list of steps: yield an event, call `decide`, wait for a promise or for the cancel, hang, or throw.
- `runTurn(adapter, options)` plays the bot runner for one turn. It sends `initialize`, `turn.start` and `shutdown`, and returns every event. Pass `decider`, `decisionDeadlineMs` or `cancelGraceMs` to change the runtime.
- `startAdapter(adapter, options)` gives the same fake bot runner step by step, with `startTurn`, `cancel`, `shutdown` and `untilEvent`, for tests that cancel or start a second turn.
- `checkStream(events)` checks a stream against [the rules](#rules-a-stream-follows).

A test for an adapter runs the events it produces through `checkStream` and expects an empty list.

## Versions

`adapterApiVersion` is `0.1.0`. It follows the same rules as [the plugin API version](plugin-manifest.md#the-api-range). A new event or field raises the minor version, or the patch version before 1.0.0. A changed or removed one raises the major version, or the minor version before 1.0.0.

## What comes later

- [#20](https://github.com/jcore9/Aphelion/issues/20) builds the Claude adapter and the fixed permission rule.
- [#216](https://github.com/jcore9/Aphelion/issues/216) makes a cancel and a stop leave no process of the bot alive.
- [#23](https://github.com/jcore9/Aphelion/issues/23) adds the frames that carry these events to clients, with bot and session ids and a saved format version. `packages/protocol` doesn't change before then.
- [#25](https://github.com/jcore9/Aphelion/issues/25) adds recorded streams that replay through an adapter.
