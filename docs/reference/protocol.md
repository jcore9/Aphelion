# The client protocol

The server and every client, such as the web app or the desktop app, talk over one connection. Each message on it is a *frame*, a small JSON object. A client sends *commands*, which ask the server to do something. The server sends back *results*, and it also sends *events*, which tell every client that something happened. `@aphelion/protocol` defines the frames and the logic that both sides share. It uses only web-standard APIs, so the same code runs in Bun, Node and the browser. Relative imports end in `.ts`, so Node 24 loads the source files directly. `web-packages-on-node.test.ts` checks that in a real Node process. [Decision 0037](../decisions/0037-protocol-frames-in-zod.md) explains how the frames are described and validated.

[The protocol spec](protocol-spec.md) lists every frame type with its fields, every command and event with its payload, the shared types and the error codes. A test generates that page from the schemas and fails CI when the committed page is out of date. This page explains how the pieces work together.

## Code

| File | Holds |
| --- | --- |
| `packages/protocol/src/registry.ts` | The commands and events. Add new ones here. |
| `packages/protocol/src/frames.ts` | The frame schemas and types, `parseClientFrame`, `parseServerFrame` and `encodeFrame` |
| `packages/protocol/src/bot-events.ts` | The schemas of the `bot.event` payload. They copy the adapter events so the package needs no `plugin-sdk`. |
| `packages/protocol/src/command-ledger.ts` | `CommandLedger`, which applies each command id once in memory, for clients and tests |
| `packages/protocol/src/spec.ts` | `renderSpec` and `schemaFiles`, which turn the schemas into the protocol spec and the JSON Schema files |

## Frames

Every frame is a JSON object with `v: 1` and a `type`. A frame with any other `v`, or with a field the frame type doesn't define, is rejected.

A client sends `command` frames and `resume` frames. The server answers a command with a `result` frame, and it sends `event`, `resync` and `error` frames.

To add a command or an event, add one entry to `commands` or `events` in `registry.ts`. Give each field a `.describe()` text, because the spec shows it. The frame unions, the parsers and the types pick the entry up from there. Then regenerate the spec and the JSON Schema files:

```sh
bun --bun vitest run -u packages/protocol
```

The test fails in CI until the regenerated files are committed.

## Errors

Two error codes cover a frame the server can't read. `malformed` covers text that isn't JSON, an unknown frame type, an unknown command or event name, and a payload that doesn't match its schema. `unsupported-version` means that `v` isn't 1. When a rejected frame has a valid command `id`, the error carries it, so the client knows which command failed.

These codes answer a command that the server read and then couldn't finish. Each error frame carries the command's `id`:

| Code | Meaning |
| --- | --- |
| `bot-not-running` | The bot isn't running, the server doesn't know its name, or the server runs no bots. |
| `bot-busy` | The bot is still in another turn, or the bot hasn't yet said whether it accepts the turn before this one. |
| `prompt-too-long` | The prompt is over 262,144 bytes (256 KiB) of UTF-8. |
| `bot-not-responding` | The bot didn't accept the turn within 30 seconds. The server ends the turn as refused. |
| `prompt-refused` | The bot refused the turn, the turn had already ended, or the server couldn't save it. |
| `interrupted` | The server stopped while it ran this command, so it can't say whether the command took effect. It doesn't run the command again. Check the bot's history before you send the command with a new `id` ([command ids](#command-ids)). |
| `storage-failed` | The server ran the command but couldn't save its result, even after it tried again. The command did take effect. A repeat of the `id` gets `interrupted`. Check the bot's history before you send the command with a new `id`. |
| `device-revoked` | The device's token was revoked or expired since the connection opened. The server checks before it runs each `bot.prompt` or `bot.cancel`, sends this error, and closes the socket with code 1008. It runs nothing and saves no `id`. |
| `id-reused` | The `id` already ran a different command. |
| `internal` | The server failed in a way it didn't expect. |

An error `message` is fixed text. For bad JSON it is `frame is not valid JSON`, and for another version it is `unsupported frame version; expected v 1`. For a frame with the wrong shape, it is the path of each bad field and a fixed reason, such as `cursor.seq: out of range` or `unknown field`. For a failed command it is one fixed sentence per code. It never repeats a field name or a value that the sender chose, such as a prompt, so it is safe to log.

## Sequence numbers and replay

The server keeps one event stream. Its id is the stream ID, a UUID that the server makes on its first start and keeps in its database, so a restart keeps the stream. It is not the server ID. A restore gives the server a new stream ID. The server saves every event in the database before it sends it to a client, and it gives each one a position: 1, 2, 3 and so on. The position is the `seq` of the event frame. A cursor names a stream and the position of the last event a client has seen:

```json
{ "stream": "0192f0a0-7c1e-7a3b-8d2f-5e4c3b2a1d09", "seq": 41 }
```

A client sends `resume` with its cursor after it connects and after it reconnects. The server answers with one of these:

- The events after the cursor, in order, and then every new event as the server saves it. A client that is up to date gets no replay. A client can send `resume` again on the same connection. The server then stops the earlier replay and starts over from the new cursor.
- One `resync` frame with the server's current cursor, and nothing more until the client sends `resume` again. The server sends it when the cursor is `null`, names another stream, or is ahead of the server. It also sends it when the cursor is more than one behind the oldest retained event. A cursor at the position just before the oldest retained event is accepted. The server never replays part of the history.

For example, when the server has events 2 and 3, a cursor at 1 gets events 2 and 3. A cursor at 0 gets `resync`. A client that has no cursor sends `resume` with `null`, takes the cursor from the `resync` frame, and sends `resume` again with it.

The server subscribes to new events before it reads the saved ones, sends the saved ones in pages, and then sends the new ones that have a higher position than the last one it sent. A client with a cursor the server accepts gets every client-visible saved event after that cursor, in order, with no gap and no repeat, even when the bot writes while the replay runs. The server saves only events whose turn it started, so a client never sees an event the server refused ([how events are written](store.md#how-events-are-written)).

The server sends an event only after the database has committed it, so a client never sees an event that a restart would lose. The server writes events in batches of up to 200, or whatever arrived in a 50-millisecond window. That is the normal batching window, so a client normally sees an event about 50 milliseconds after the bot sent it. It is not a delivery deadline: while a write is failing and the server retries it, events wait longer.

A crash or a power loss keeps every event the database committed. It can lose the events that were still waiting, which is normally the last 50 milliseconds. While a write is failing and the server retries it, more events wait, and a crash then loses all of them. No client ever received a lost event, because clients only get saved events. At the next boot the server closes every turn it had started and not ended, so the saved history stays valid. An orderly shutdown saves every waiting event, unless its final write fails ([how events are written](store.md#how-events-are-written)).

A restore from a backup brings back the positions that the backup had. So that no client takes a new event for one it already saw, `aphelion restore finish` gives the server a new stream ID in the same transaction as its other steps. The server ID stays the same. Every cursor saved before the restore names the old stream, so the server answers it with `resync`. Positions keep counting from the restored value. A client that gets `resync` takes the new cursor and loads the history again.

The server keeps a buffer of new events for each client. It fills while the server replays saved events to that client, and while the server's own sending queue for that client is behind. The buffer holds at most 5,000 events. When a client's buffer would go past that, the server closes that client's connection with code 1013 and the reason `client too slow, reconnect`. Other clients are not affected, and the server's memory stays bounded.

That limit covers only Aphelion's buffer. Below it, Bun has its own send buffer for each connection. When a client reads so slowly that Bun's buffer fills, Bun drops the connection without the 1013 code. The client sees the connection end, reconnects, and sends `resume` with its cursor. Either way, a client that reconnects with a cursor the server accepts gets every client-visible saved event after it and loses none. A cursor more than one behind the oldest retained event gets `resync` instead.

If the server can't read a saved event, it closes the connection with code 1011 and the reason `history could not be read`. The server never skips an event.

### The `bot.event` frame

One `bot.event` frame carries one event of one bot. Its payload has the bot's name, the turn's id, the format version and the event:

```json
{
	"v": 1,
	"type": "event",
	"seq": 42,
	"name": "bot.event",
	"payload": {
		"bot": "chief",
		"turn": "0192f0a1-3b7d-7c5e-9a21-0d4e6f8a1b23",
		"format": 1,
		"event": { "type": "text.delta", "text": "Hello" }
	}
}
```

`turn` is `null` for an `error` outside a turn. `event` is one of the kinds in [the bot adapter contract](bot-adapters.md), and [the protocol spec](protocol-spec.md#botevent) lists their fields. The frame has no vendor session id. The server keeps that id, and a client has no use for it. The server never sends a `session` event, live or in a replay, so a client may see `seq` jump over the position of one.

`format` is the version of the saved event's shape. It is 1 today. A change to an event's shape raises it, and the server keeps reading the older rows. A client that sees a `format` it doesn't know should show the event as unreadable and go on.

The frame carries the text of the conversation. The server never writes it to a log line.

## Commands

A client sends a `command` frame and gets one `result` frame, or one `error` frame, with the same `id`. A client can send the next command before the answer to the last one arrives, and the answers can arrive in any order. [The protocol spec](protocol-spec.md#commands) lists every field.

| Command | Does | Result |
| --- | --- | --- |
| `ping` | Nothing. It checks that the server answers. | `{}` |
| `bot.prompt` | Gives a bot a prompt and starts a turn. | `{ "turn": "..." }` |
| `bot.cancel` | Asks a bot to cancel a turn. | `{}` |
| `history.read` | Reads one page of a bot's saved events. | `{ "events": [...], "next": 9, "more": true }` |

### `bot.prompt`

The payload is `{ "bot": "chief", "text": "Hello" }`. The server starts a turn and answers with the turn's id, a UUIDv7 that the server makes. The answer comes when the bot accepts the turn, not when the bot finishes it. The turn's events arrive as [`bot.event` frames](#the-botevent-frame) for a client that has sent `resume`. A repeat of the command with the same `id` returns the same turn and starts no second one.

The prompt can hold up to 262,144 bytes (256 KiB) of UTF-8. A longer prompt gets `prompt-too-long`, and the socket stays open. A prompt of more than 262,144 characters can't fit, so the server reads it as `malformed` and closes the socket with code 1007.

The server reads a message of up to 1 MiB (1,048,576 bytes) after JSON encoding. It closes the socket with code 1009 when a message is larger. A 256 KiB prompt fits, unless most of its characters are ones that JSON writes as escapes, such as control characters, which take up to 6 bytes each.

A bot takes one new turn at a time. While the server waits for the bot to accept a turn, another `bot.prompt` for that bot gets `bot-busy`. The server waits at most 30 seconds. After that it ends the turn as refused and answers `bot-not-responding`. If the bot accepts the turn later, the server tells it to cancel the turn.

The command fails with `bot-not-running`, `bot-busy`, `bot-not-responding`, `prompt-too-long` or `prompt-refused`. A client that wants to try again sends the prompt with a new `id`.

### `bot.cancel`

The payload is `{ "bot": "chief", "turn": "0192f0a1-3b7d-7c5e-9a21-0d4e6f8a1b23" }`. The command succeeds with `{}` as soon as the server has passed the request on. It also succeeds when the bot isn't in that turn, so a client can send it without checking first. The turn ends with a `turn.end` event whose reason is `cancelled`, and a bot that ignores the cancel doesn't end the turn.

### `history.read`

The payload is `{ "bot": "chief", "after": 7, "limit": 100 }`. `after` is a position, as in the `seq` of an event frame, and it is optional. Leave it out to start at the oldest event. `limit` is from 1 to 500.

The result holds up to `limit` events of that bot, in order, each as `{ "seq": 8, "payload": { ... } }`. The `payload` is the payload of the matching `bot.event` frame. The server shows the same events that a replay shows and leaves out the same ones, so a client never gets the vendor's session reference. An event has the same `seq` in a page and in a replay, so a client that uses both can drop a repeat by `seq`.

`next` is the position to send as `after` for the next page. It can be higher than the last event in the page, because the server counts the events it skips. `more` is `true` when the server holds more saved events of this bot after `next`. A page can hold fewer than `limit` events, or none, while `more` is `true`, so a client reads until `more` is `false`.

The command only reads. The server doesn't save its `id`, and a repeat reads the history again, so it sees events saved since. The command fails with `internal` when the server can't read a saved event ([store](store.md#the-server-id-turns-and-events)).

## Command ids

A client gives every command an `id` of 1 to 64 letters, digits, hyphens or underscores. A UUID, which is a universally unique identifier, from `crypto.randomUUID()` fits. When a client gets no answer, it sends the same command again with the same `id`.

### What the server does with an id

The server saves the `id` and the outcome of `bot.prompt` and `bot.cancel` in its database for 24 hours, so a repeat never runs twice, also after a restart. `ping` and `history.read` change nothing, so the server doesn't save them.

- The server saves the `id` before it runs the command, and the result when the command ends. When saving the result fails, the server tries again up to three times, after 0.1, 0.5 and 2 seconds, without running the command again. It sends the result only after it has saved it. The key is the device and the `id`, so two devices can use the same `id` without meeting.
- A repeat within 24 hours gets the saved outcome, whether that was a result or an error. A repeat that arrives while the first run is still going waits for that run. A client that disconnects after it sends a command doesn't stop it. The client reconnects, sends the same `id`, and gets the outcome.
- The server doesn't know what happened to a command that was still running when the server stopped. The prompt may have reached the bot. A repeat gets the error `interrupted`, and the command doesn't run again. The client sends it with a new `id` if it still wants it, after it checks the bot's history.
- A repeat that names a different command than the first run of that `id` gets `id-reused`. The server doesn't compare the payloads, so a client must not give two commands with one name the same `id`.
- A repeat after 24 hours counts as a new command. The server deletes its saved rows when it starts and then once an hour. It deletes a row that is still `running` once it is 24 hours old. It measures the time with its own clock, so a clock set back keeps a row longer.

A client that wants a command to run twice sends two ids.

### The ledger in the package

`@aphelion/protocol` also has `CommandLedger`, which keeps outcomes in memory for clients and tests. It applies each id once. A retry gets the first run's outcome, whether that was a result or a failure. A command that throws before it returns counts as a failure too. A retry that arrives while the first run is still going waits for that run.

The ledger keeps every id whose command is still running, plus the most recently finished ids, up to `capacity` ids in all. It forgets finished ids in the order they finished. It never forgets a running one, so it holds more than `capacity` ids while more than `capacity` commands run at once. For example, at a capacity of 1, if `b` finishes while an older `a` is still running, the ledger forgets `b` and keeps `a`. A forgotten id runs again if a client sends it. The server doesn't use this class. Its ledger is in `apps/server/src/commands/` and keeps its rows in SQLite.
