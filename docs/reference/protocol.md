# The client protocol

The server and every client, such as the web app or the desktop app, talk over one connection. Each message on it is a *frame*, a small JSON object. A client sends *commands*, which ask the server to do something. The server sends back *results*, and it also sends *events*, which tell every client that something happened. `@aphelion/protocol` defines the frames and the logic that both sides share. It uses only web-standard APIs, so the same code runs in Bun, Node and the browser. Relative imports end in `.ts`, so Node 24 loads the source files directly. `web-packages-on-node.test.ts` checks that in a real Node process. [Decision 0037](../decisions/0037-protocol-frames-in-zod.md) explains how the frames are described and validated.

[The protocol spec](protocol-spec.md) lists every frame type with its fields, every command and event with its payload, the shared types and the error codes. A test generates that page from the schemas and fails CI when the committed page is out of date. This page explains how the pieces work together.

## Code

| File | Holds |
| --- | --- |
| `packages/protocol/src/registry.ts` | The commands and events. Add new ones here. |
| `packages/protocol/src/frames.ts` | The frame schemas and types, `parseClientFrame`, `parseServerFrame` and `encodeFrame` |
| `packages/protocol/src/bot-events.ts` | The schemas of the `bot.event` payload. They copy the adapter events so the package needs no `plugin-sdk`. |
| `packages/protocol/src/command-ledger.ts` | `CommandLedger`, which applies each command id once |
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

The error codes are `malformed` and `unsupported-version`. `malformed` covers text that isn't JSON, an unknown frame type, an unknown command or event name, and a payload that doesn't match its schema. `unsupported-version` means that `v` isn't 1. When a rejected frame has a valid command `id`, the error carries it, so the client knows which command failed.

An error `message` is fixed text. For bad JSON it is `frame is not valid JSON`, and for another version it is `unsupported frame version; expected v 1`. For a frame with the wrong shape, it is the path of each bad field and a fixed reason, such as `cursor.seq: out of range` or `unknown field`. It never repeats a field name or a value that the sender chose, so it is safe to log.

## Sequence numbers and replay

The server keeps one event stream. Its id is the server ID, a UUID that the server makes once and keeps in its database, so a restart or a restore keeps the stream. The server saves every event in the database before it sends it to a client, and it gives each one a position: 1, 2, 3 and so on. The position is the `seq` of the event frame. A cursor names a stream and the position of the last event a client has seen:

```json
{ "stream": "0192f0a0-7c1e-7a3b-8d2f-5e4c3b2a1d09", "seq": 41 }
```

A client sends `resume` with its cursor after it connects and after it reconnects. The server answers with one of these:

- The events after the cursor, in order, and then every new event as the server saves it. A client that is up to date gets no replay. A client can send `resume` again on the same connection. The server then stops the earlier replay and starts over from the new cursor.
- One `resync` frame with the server's current cursor, and nothing more until the client sends `resume` again. The server sends it when the cursor is `null`, names another stream, or is ahead of the server. It also sends it when the cursor is more than one behind the oldest event the server still has. The server never replays part of the history.

For example, when the server has events 2 and 3, a cursor at 1 gets events 2 and 3. A cursor at 0 gets `resync`. A client that has no cursor sends `resume` with `null`, takes the cursor from the `resync` frame, and sends `resume` again with it.

The server subscribes to new events before it reads the saved ones, sends the saved ones in pages, and then sends the new ones that have a higher position than the last one it sent. A client sees no gap and no repeat, even when the bot writes while the replay runs.

The server sends an event only after the database has committed it, so a client never sees an event that a restart would lose. The server writes events in batches of up to 200, or whatever arrived in 50 milliseconds. A client sees an event up to 50 milliseconds after the bot sent it.

A restore from a backup brings back the server ID and the positions that the backup had. A client that saw events newer than the backup gets `resync`, as long as the restored server is behind it. When the restored server saves new events past that position, the client can no longer tell that the history changed. Reload every client after a restore.

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

`turn` is `null` for a `session` event and for an `error` outside a turn. `event` is one of the kinds in [the bot adapter contract](bot-adapters.md), and [the protocol spec](protocol-spec.md#botevent) lists their fields. The frame has no vendor session id. The server keeps that id, and a client has no use for it.

`format` is the version of the saved event's shape. It is 1 today. A change to an event's shape raises it, and the server keeps reading the older rows. A client that sees a `format` it doesn't know should show the event as unreadable and go on.

The frame carries the text of the conversation. The server never writes it to a log line.

## Command ids

A client gives every command an `id` of 1 to 64 letters, digits, hyphens or underscores. A UUID, which is a universally unique identifier, from `crypto.randomUUID()` fits. When a client gets no answer, it sends the same command again with the same `id`.

`CommandLedger` applies each id once. A retry gets the first run's outcome, whether that was a result or a failure. A command that throws before it returns counts as a failure too. A retry that arrives while the first run is still going waits for that run.

The ledger keeps every id whose command is still running, plus the most recently finished ids, up to `capacity` ids in all. It forgets finished ids in the order they finished. It never forgets a running one, so it holds more than `capacity` ids while more than `capacity` commands run at once. For example, at a capacity of 1, if `b` finishes while an older `a` is still running, the ledger forgets `b` and keeps `a`. A forgotten id runs again if a client sends it. A client that wants a command to run twice sends two ids.
