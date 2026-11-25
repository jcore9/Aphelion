# 0054. At service stop each plugin gets 5 seconds with a 10-second cap for all, and the SDK waits up to 3 seconds for running event handlers before cleanup

- Status: Accepted (approved by merging #170 on 2026-11-23)
- Date: 2026-11-23
- Decided by: project owner
- Proposed by: the orchestrator, in the PR for [#164](https://github.com/jcore9/Aphelion/issues/164) (M0-20)
- Answers: how long plugins get to stop when the Aphelion service stops, and what the plugin SDK does with an event handler that is still running at shutdown

## Context

A plugin is a separate program that Aphelion starts. When the owner stops one plugin, the host sends it `shutdown`, a polite "please exit" message, and the runner kills it if it is still running 5 seconds later. [The plugin reference](../reference/plugins.md) promises this.

When the whole service stopped, the host skipped that step and had the runner kill every plugin at once. A plugin that saves its work only when it exits lost that work. [#164](https://github.com/jcore9/Aphelion/issues/164) fixes this.

Two limits frame the fix:

- The container's launcher gives the server 20 seconds to exit, then kills it ([Stopping](../reference/container.md#stopping)). The plugins must stop well inside that time, because the server has other things to close.
- An event handler is the plugin's function that runs when an event arrives. Cleanup is the plugin's own function that closes its files and connections at shutdown. Before this change, the SDK could run cleanup while a handler was still working, so the handler could use a file that cleanup had already closed.

## Options

### How long plugins get at service stop

The host sends `shutdown` to every plugin at the same time, so the plugins wait side by side, not one after the other.

1. **5 seconds for each plugin, and at most 10 seconds for all of them.**
   - For: a plugin gets the same 5 seconds as when the owner stops it alone, which is what the docs already promise. 10 seconds leaves half of the launcher's 20 for the rest of the server.
   - Against: a stop takes up to 10 seconds when a plugin doesn't exit.
2. **3 seconds for each plugin, and at most 6 seconds for all of them.**
   - For: the service stops faster.
   - Against: a plugin gets less time at service stop than at a single stop, so a plugin author has two numbers to know.
3. **10 seconds for each plugin, and at most 15 seconds for all of them.**
   - For: more time for a plugin that saves a lot of data.
   - Against: only 5 seconds of the launcher's 20 remain for the rest of the server, and the single-stop grace would have to change too.

### What the SDK does with a slow handler

1. **Wait up to 3 seconds for running handlers, then run cleanup anyway.**
   - For: cleanup always runs inside the 5 seconds, with about 2 seconds to spare.
   - Against: a handler that runs longer than 3 seconds can find its files or connections closed.
2. **Wait for running handlers with no limit in the SDK.**
   - For: simpler, and cleanup never runs under a handler.
   - Against: a handler that runs longer than 5 seconds means the runner kills the plugin before cleanup runs, so cleanup never runs at all.

## Decision

The owner chose option 1 in both cases.

At service stop:

- The host stops taking `start` requests and sends `shutdown` to every running plugin at the same time.
- Each plugin gets the usual 5 seconds (`RestartPolicy.graceMs`) before the runner kills it.
- One deadline of 10 seconds (`defaultStopDeadlineMs` in [`host.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/plugins/host.ts)) caps the whole plugin stop. After 9 seconds, the host tells the runner to kill every plugin that is still running, and logs which ones. It then closes the pipe to the runner.

In the SDK, once shutdown starts:

- No new event reaches a handler.
- Every call to the host that waits for its reply, and every new call, fails at once with `the plugin is shutting down`. The host ignores a plugin after it sends `shutdown`, so no reply would come.
- The SDK waits up to 3 seconds for handlers that are still running. It then runs cleanup, and logs the event name of each handler that still runs. It never logs the event's data.

## Consequences

- A plugin that saves its work on `shutdown` keeps it when the service stops.
- A stop of the service takes about 5 seconds longer when a plugin ignores `shutdown`, and the plugin stop never takes more than 10 seconds.
- Plugin authors should keep handlers short and save their work as they go. [The plugin reference](../reference/plugins.md#when-your-plugin-stops) says what happens to a handler past 3 seconds.
- Revisit the numbers if plugins need more time to save, or if the launcher's 20 seconds change.
