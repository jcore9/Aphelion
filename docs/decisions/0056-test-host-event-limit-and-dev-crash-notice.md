# 0056. The test host rejects an event the real host would refuse, and `plugin dev` reports a crash after the handshake

- Status: Accepted (approved by merging #172 on 2026-11-23)
- Date: 2026-11-23
- Decided by: project owner
- Proposed by: the orchestrator, in the PR for [#166](https://github.com/jcore9/Aphelion/issues/166) (M0-22)
- Answers: what `createTestHost`'s `publish` does with an event over the size limit, and how `aphelion plugin dev` tells the operator about a plugin whose `start` fails after the handshake

## Context

A plugin's tests run against `createTestHost`, a fake host in the SDK. The M0 plan promises that a plugin that works in the test host works in the container unchanged ([Keeping it extensible](../plan/milestones/M0-foundations.md#keeping-it-extensible)). Two gaps broke that promise.

- **Event size.** The real host refuses to send a message whose line is longer than 1 MiB, and the event then reaches no plugin. The test host had no limit, so a test could pass with an event the real host never sends.
- **The handshake.** The host counts a plugin as running once it answers `initialize`, the first message the host sends. The SDK answers before it calls the plugin's `start`. So `start` can fail after `aphelion plugin dev` printed `Reloaded weather: running`, and the operator saw nothing more. The test host reports the same failure as an error from its `start`.

## Options

### What the test host does with a too-big event

1. **Reject.** `publish` fails with an error that names the limit, and sends nothing.
   - For: a test that sends a too-big event fails, and the message says why. The caller of the real host's `publish` gets an error too.
   - Against: none found. A test that sent such an event was already testing something production never does.
2. **Send nothing, quietly.** `publish` resolves, and the plugin never gets the event.
   - For: the plugin sees exactly what it sees in production.
   - Against: the test author gets no hint why the handler never ran.

### How `plugin dev` reports a failure after the handshake

1. **Keep listening.** Each reload prints its line at once. If that run then crashes before the next reload, the command prints one more line.
   - For: a healthy reload isn't slower, and a `start` that fails late is still reported.
   - Against: the dev socket gets a second kind of message besides the reply.
2. **Wait 2 seconds after the handshake.** Each reload reports a crash that happens in that window.
   - For: one reply per request, as before.
   - Against: every reload takes 2 seconds longer, and a `start` that fails after 2 seconds is missed.
3. **Change only the wording.** Say "the handshake finished" and report no crash.
   - Against: doesn't meet #166.

## Decision

The owner chose option 1 in both cases.

- The real host and the test host share one limit from the SDK: 1 MiB, counted as UTF-8 bytes of the whole JSON-RPC line without its newline. An event over it reaches no plugin. The real host's `publish` fails, and the test host's `publish` rejects with `the event is longer than 1 MiB once encoded, so the host refuses it`.
- `plugin dev` prints `Reloaded weather: the handshake finished.` for a plugin that reached the running state. If that run crashes before the next reload on the same connection, it prints `weather crashed after the handshake. If its start() failed, the server log says why.` A stop that someone asked for prints nothing. Each reload gets at most one such line.

## Consequences

- A plugin test that published an event over 1 MiB now fails. It never worked in production.
- The dev socket's messages carry a type, so the command can tell a crash notice from the reply to its request. The command and the server ship in the same image, so no older client reads it.
- The server starts watching for the crash right after it sends the reply. If the plugin crashes and a requested stop, such as the service stopping, arrives in that same instant, the stop wins and no notice is printed. Someone asked for that stop, so nothing is lost.
- Revisit the notice if the SDK ever tells the host when `start` has finished. The command could then say so directly.
