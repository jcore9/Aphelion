# The client protocol

The server and every client, such as the web app or the desktop app, talk over one connection. Each message on it is a *frame*, a small JSON object. A client sends *commands*, which ask the server to do something. The server sends back *results*, and it also sends *events*, which tell every client that something happened. `@aphelion/protocol` defines the frames and the logic that both sides share. It uses only web-standard APIs, so the same code runs in Bun, Node and the browser. Relative imports end in `.ts`, so Node 24 loads the source files directly. `web-packages-on-node.test.ts` checks that in a real Node process. [Decision 0037](../decisions/0037-protocol-frames-in-zod.md) explains how the frames are described and validated.

M0-09b replaces this page with a spec generated from the schemas.

## Code

| File | Holds |
| --- | --- |
| `packages/protocol/src/registry.ts` | The commands and events. Add new ones here. |
| `packages/protocol/src/frames.ts` | The frame schemas and types, `parseClientFrame`, `parseServerFrame` and `encodeFrame` |
| `packages/protocol/src/event-log.ts` | `EventLog`, which numbers events and answers a reconnect |
| `packages/protocol/src/command-ledger.ts` | `CommandLedger`, which applies each command id once |

## Frames

Every frame is a JSON object with `v: 1` and a `type`. A frame with any other `v`, or with a field the frame type doesn't define, is rejected.

A client sends these frames:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `command` | `id`, `name`, `payload` | Run the command `name`. The client picks `id`. |
| `resume` | `cursor`, or `null` | Send the events after `cursor`. A client with no cursor sends `null`. |

The server sends these frames:

| `type` | Fields | Meaning |
| --- | --- | --- |
| `result` | `id`, `name`, `result` | The command `id` succeeded. |
| `event` | `seq`, `name`, `payload` | Event number `seq` happened. |
| `resync` | `cursor` | The client can't catch up from its cursor. It reloads its state and continues from `cursor`. |
| `error` | `code`, `message`, and `id` when the error belongs to a command | A frame was rejected. |

The error codes are `malformed` and `unsupported-version`. `malformed` covers text that isn't JSON, an unknown frame type, an unknown command or event name, and a payload that doesn't match its schema. `unsupported-version` means that `v` isn't 1. When a rejected frame has a valid command `id`, the error carries it, so the client knows which command failed.

An error `message` is fixed text. For bad JSON it is `frame is not valid JSON`, and for another version it is `unsupported frame version; expected v 1`. For a frame with the wrong shape, it is the path of each bad field and a fixed reason, such as `cursor.seq: out of range` or `unknown field`. It never repeats a field name or a value that the sender chose, so it is safe to log.

## Commands and events in M0

| Kind | Name | Payload | Result |
| --- | --- | --- | --- |
| Command | `ping` | `{}` | `{}` |
| Event | `notice` | `{ "message": string }` | |

To add a command or an event, add one entry to `commands` or `events` in `registry.ts`. The frame unions, the parsers and the types pick it up from there.

## Sequence numbers and replay

The server keeps one event stream. A stream has an id, and `EventLog` numbers its events 1, 2, 3 and so on. A cursor names a stream and the last sequence number a client has seen:

```json
{ "stream": "a1b2c3", "seq": 41 }
```

The server keeps the last `capacity` events. When a client reconnects, it sends `resume` with its cursor. The server answers with one of these:

- The events after the cursor, in order, when the server still has all of them. A client that is up to date gets no events.
- One `resync` frame with the server's current cursor. The server sends it when the cursor is `null`, names another stream, or is ahead of the server. It also sends it when the cursor is more than one behind the oldest event the server kept. The server never replays part of the history.

For example, when the server keeps events 2 and 3, a cursor at 1 gets events 2 and 3, and a cursor at 0 gets `resync`.

`append` checks the event against its schema before it gives the event a number. An event that doesn't match is rejected with an error, and the log doesn't change, so sequence numbers never have a gap. Kept events can't be changed. `EventLog` stores a frozen copy of the checked event, so neither the caller of `append` nor the receiver of a replayed frame can alter the history.

A server that restarts with an in-memory log starts a new stream with a new id, so a cursor from before the restart gets `resync`.

## Command ids

A client gives every command an `id` of 1 to 64 letters, digits, hyphens or underscores. A UUID from `crypto.randomUUID()` fits. When a client gets no answer, it sends the same command again with the same `id`.

`CommandLedger` applies each id once. A retry gets the first run's outcome, whether that was a result or a failure. A command that throws before it returns counts as a failure too. A retry that arrives while the first run is still going waits for that run.

The ledger keeps every id whose command is still running, plus the most recently finished ids, up to `capacity` ids in all. It forgets finished ids in the order they finished. It never forgets a running one, so it holds more than `capacity` ids while more than `capacity` commands run at once. For example, at a capacity of 1, if `b` finishes while an older `a` is still running, the ledger forgets `b` and keeps `a`. A forgotten id runs again if a client sends it. A client that wants a command to run twice sends two ids.
