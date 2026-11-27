# The bot runner

The **bot runner** starts and stops the bots. It is one process, `bot-runner.js`, that runs as the `aphelion-bot` user. For each bot it starts one **adapter** process, the code that drives the bot's AI tool ([bot adapters](bot-adapters.md)). The server never starts, signals or reads a bot process itself. It sends the bot runner a message, and the bot runner does the work.

## How the server and the bot runner talk

The [launcher](container.md#how-the-processes-start) creates two pipes for the bot runner, as it does for the plugin runner. A pipe is a one-way channel between two processes. The bot runner reads requests on its standard input and writes replies on its standard output. The server holds the other ends as descriptors 5 and 6 (`--bot-runner-fds 5,6`). No other process holds them, and no file leads to them.

Each message is one JSON object on one line, at most 8 MiB. Every message names the bot and a **run** number. The server counts runs up by one for each start of a bot. The bot runner ignores a message for a run that isn't the bot's current one.

| From | Message | What it does |
| --- | --- | --- |
| Server | `start` | Starts the bot's adapter with the bot's provider, adapter file, folder and the session to resume, or `null` |
| Server | `turn.start` | Sends the bot one prompt, at most 256 KiB |
| Server | `turn.cancel` | Asks the adapter to cancel the turn |
| Server | `stop` | Stops the bot |
| Bot runner | `spawned` | The adapter process started |
| Bot runner | `started` | The adapter answered `initialize` for the right provider |
| Bot runner | `start-failed` | The process didn't start (`stage: "spawn"`), or the adapter refused `initialize` (`stage: "initialize"`) |
| Bot runner | `turn.accepted`, `turn.refused` | The adapter's answer to `turn.start`. A refusal is `not-running`, `busy`, `ended`, `too-long` or `refused`. |
| Bot runner | `event` | One event from the adapter, as [the adapter wire](bot-adapters.md#on-the-wire) shapes it |
| Bot runner | `log` | One line the adapter wrote to its standard error |
| Bot runner | `notice` | A note from the bot runner about the adapter, as a code: `line-too-long`, `not-a-message`, `stopped-reading` or `too-much-log` |
| Bot runner | `exited` | The adapter process ended without a stop, with its exit code or signal |
| Bot runner | `stopped` | The stop finished |

The bot runner checks every line from an adapter against the adapter wire, and drops a line that doesn't fit and sends a `notice` with code `not-a-message`. It never reads a bot id from an adapter. It tags each message with the bot it started that process for.

The bot runner holds at most 4 MiB of one adapter's output that it hasn't handled yet. When an adapter writes faster than the bot runner can pass its messages on, the bot runner stops reading that adapter until the backlog drains. The adapter then waits on its own writes. This is called back-pressure. It keeps one bot's flood from filling the bot runner's memory, and the other bots' messages keep moving.

Every write from the server to the bot runner pipe has a 10-second deadline. If a write does not finish within 10 seconds, or if the bot runner pipe closes while the server is running, the server treats the channel as failed. It ends every pending turn request with `not-running`, closes the pipe descriptors, logs `a write to the bot runner timed out, so the channel is closed` or `the bot runner's pipe closed` along with `the bot runner channel failed, so the server is stopping`, and exits with code 1. The launcher then stops the container and `aphelion.service` restarts both the server and the bot runner.

## What a bot process gets

The bot runner starts `bun --no-env-file --preload /usr/local/lib/aphelion/adapter-launcher.js <adapter file>` in the bot's folder from `bots.yaml`, and creates the folder with mode `0750` if it is missing. If the adapter file isn't there, the start fails at once, and the server's log line names the file. The launcher runs first in the same process. It sets the process non-dumpable, then Bun loads the adapter file ([how one bot is kept from another](#how-one-bot-is-kept-from-another)). The process gets only its standard input, output and error. It gets this environment and nothing else:

| Variable | Value |
| --- | --- |
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/var/lib/aphelion-bots`, the `aphelion-bot` user's home. Every bot shares it, so they share one sign-in per AI tool ([decision 0006](../decisions/0006-shared-bot-user.md)). |
| `LANG` | `C.UTF-8` |
| `TZ` | `UTC` |
| `TMPDIR` | `/tmp` |
| `DISABLE_AUTOUPDATER` | `1`, for a `claude` bot only, so Claude Code doesn't update itself |

`HTTPS_PROXY` and `NO_PROXY` are never set. The bot's network goes out as the container's does ([decision 0022](../decisions/0022-bot-network-boundary.md)). A later proxy changes only these two variables.

The server picks the adapter file from a fixed table, by the bot's `provider`. Today the table has one entry: `claude` runs `/usr/local/lib/aphelion/adapters/claude/adapter.js`. A bot whose provider isn't in the table doesn't start. The server logs `no adapter in this image runs the bot's provider, so the bot won't start` with the bot and the provider.

## How one bot is kept from another

Bots share the `aphelion-bot` user with the bot runner. Through the bot runner, a bot can't start, stop or send a prompt to another bot:

- A bot can't write to the server's pipe. It never gets the pipe as a descriptor.
- A bot can't open another bot's adapter pipes, or the bot runner's. Linux lets a process open another process's descriptors through `/proc/<pid>/fd`, and read its memory and environment, when both run as the same user. A **non-dumpable** process (`PR_SET_DUMPABLE=0`) refuses that to everyone but `root`. The bot runner sets itself non-dumpable, and so does each adapter process. Without this, one bot could read the prompts the bot runner sends another bot, or write events the bot runner would take as the other bot's.
- A bot can't name another bot. The bot runner reads a bot's output as adapter messages only, and tags them itself.
- A message for one bot reaches only the process the bot runner started for that bot.

The adapter becomes non-dumpable twice over, so there's no moment when a sibling can open its pipes:

- The image installs `/usr/local/bin/bun` with mode `0711`: every user can run it, and only `root` can read it. Linux makes a process non-dumpable from its first instruction when it runs a program it can't read. This covers the time Bun takes to start, before any JavaScript runs. It also covers the bot runner, the plugin runner and every plugin.
- The launcher calls `PR_SET_DUMPABLE=0` itself before the adapter loads, in case a host's `fs.suid_dumpable` setting is `1`, which would leave the first step open.

The first step depends on a setting of the host's Linux kernel, `fs.suid_dumpable`. Containers share the host's kernel, so the image can't set it. The Linux default is `0`, and with `0` there's no gap. To check it on the host, run `sysctl fs.suid_dumpable`. It should print `fs.suid_dumpable = 0`. If it prints `1`, a new adapter process stays open to its siblings for a few milliseconds, from the moment Bun starts until the launcher runs. In that window another bot could open the new adapter's pipes. The value `2` behaves like `0` here. To set it back to `0`, run `sudo sysctl -w fs.suid_dumpable=0`, and remove any line that sets it to `1` from `/etc/sysctl.conf` or `/etc/sysctl.d/`.

Some things stay open under the shared user ([decision 0006](../decisions/0006-shared-bot-user.md)):

- A bot can still signal, and so stop, another bot's processes or the bot runner itself ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)). If the bot runner dies, the launcher stops the container.
- An adapter starts the AI tool's own program, such as Claude Code. Starting a new program makes a process dumpable again, so another bot can open that program's descriptors and memory. Those pipes lead to that bot's adapter, not to the bot runner, but the program's memory holds that bot's conversation.

Separate users per bot would close both. That is a later change.

## Restart and resume

The server, not the bot runner, decides when a bot starts again. It runs each bot through the same states as a plugin:

| State | Means |
| --- | --- |
| Stopped | Not started, or stopped on request |
| Starting | The bot runner is starting the adapter, which has 15 seconds to start and 10 seconds to answer `initialize` |
| Running | The adapter is ready for a prompt |
| In turn | The adapter is working on a prompt |
| Crashed | The process ended by itself. The server waits, then starts it again. |
| Given up | The bot crashed too often and stays stopped |

A prompt sent again with the id of the turn that is running is accepted and not run a second time. A prompt sent again with the id of a turn that already ended is refused with `ended`: the turn ran once, and its events have already been sent. The adapter decides which case it is, because it knows which turns it ran, so the bot stays idle and the next prompt runs. See [what the runtime does](bot-adapters.md#what-the-runtime-does). The server itself makes a new UUIDv7 as the turn's id for every prompt, so it never sends one id twice.

After a crash the server waits 1 second, then 2, 4, 8 and 16. The sixth crash in a row gives up, and the server logs `the bot crashed too often, so it stays stopped`. A bot that ran for 60 seconds before it crashed starts the count again.

The adapter reports the AI tool's own session id in a `session` event. The server keeps the latest one for each bot, with the bot's folder and provider, and hands it to the adapter as `resume` on every start. A session saved for another folder or another provider isn't resumed, so a bot that moves or changes provider starts a new session. If the adapter refuses `initialize` while it resumes, the server forgets the saved session, logs `the saved session could not be resumed, so the bot started a new one`, and starts the bot again at once without it. That retry doesn't count as a crash.

The server keeps the saved session in the `bot_sessions` table of its database ([the store](store.md#the-server-id-turns-and-events)), so a restart of the server or the container keeps it. A restored backup brings it back too.

The server also saves every event a bot sends, with the turn it belongs to, and it sends the event to every connected client as a `bot.event` frame. [The client protocol](protocol.md#sequence-numbers-and-replay) explains how a client that reconnects gets the events it missed. When the server itself stops in the middle of a turn, it closes that turn at the next boot ([turns that a shutdown left open](store.md#turns-that-a-shutdown-left-open)).

## What the server logs about a bot

The server never writes what a bot prints to its standard error into its log. It logs only the bot's name and how many lines the bot has printed since its process started, because an adapter can echo a prompt in a diagnostic. A `notice` isn't standard error, so the server doesn't count it as a line. It logs one fixed sentence for each code, with the bot's name and the run, and never any text from the adapter.

## When a bot process dies

If an adapter process ends in the middle of a turn, the adapter can't finish its stream. The bot runner finishes it, as [the adapter wire](bot-adapters.md#the-wire) says. It adds an `error` with code `cli-exited`, a `deny` for each permission request that has no answer, a `tool.end` with outcome `cancelled` for each call still open, and a `turn.end` with reason `error`. Then it sends `exited`. The bot runner never sends the prompt again, because a second run could repeat what a tool already did.

An adapter that closes its standard output counts as gone, even if its process keeps running, because the bot runner can no longer hear it. The bot runner finishes the stream at once, as above. It refuses with `not-running` any prompt still waiting for the adapter's answer, and any new one. Then it kills the adapter and sends `exited`, so the server restarts the bot.

The bot runner also kills an adapter that stops reading its input for 5 seconds. It sends the `stopped-reading` notice, and the server logs `the adapter stopped reading its input, and the runner killed it`.

## How a bot stops

On `stop`, the bot runner sends the adapter `shutdown` and gives it 5 seconds to exit. It then freezes every process still in the adapter's process tree with `SIGSTOP`, and kills them with `SIGKILL`. This is the plugin runner's tree walk ([decision 0046](../decisions/0046-plugin-runner-kills-process-trees.md)).

The tree walk finds a process through its parent. A process whose parent already exited, such as a command an adapter left running after its own exit, is no longer in the tree, and the stop misses it. [#216](https://github.com/jcore9/Aphelion/issues/216) replaces the kill so that nothing a bot started survives.

When the server stops, it stops every bot, with at most 15 seconds for all of them. The bot runner exits when the server closes the pipe, and kills any bot that is left.

## Tests

- `apps/server/src/bots/runner.test.ts` runs the bot runner with the SDK's runtime and fake adapters in the same process. It checks a start, a turn and a stop, resume, the repaired stream, the isolation rules, and the refusals.
- `apps/server/src/bots/runner-process.test.ts` runs the real bot runner over two named pipes, with a real Bun adapter. It checks that the adapter gets exactly the environment above, holds neither pipe, and can't read the bot runner's descriptors or environment, and that another process of the same user can't open the adapter's descriptors. It checks the tree kill and a repaired stream after `SIGKILL`.
- `apps/server/src/bots/manager.test.ts` runs the server's bot manager against the bot runner. It checks restart with resume, giving up, the retry without a session, the folder check, and an unknown provider.
- [`deploy/test/image-contract.sh`](https://github.com/jcore9/Aphelion/blob/main/deploy/test/image-contract.sh) checks the shipped image. The bot runner runs as `aphelion-bot` and holds its own pipes and no others. A fake adapter bot starts, answers one turn and stops, with the environment above. A second `aphelion-bot` process can't open the adapter's descriptors, or those of a `bun` started without the launcher.

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/bots/runner.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/runner.ts) | The bot runner |
| [`apps/server/src/bots/runner-protocol.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/runner-protocol.ts) | The messages between the server and the bot runner |
| [`apps/server/src/bots/stream.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/stream.ts) | The stream repair |
| [`apps/server/src/bots/environment.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/environment.ts) | A bot's environment |
| [`apps/server/src/bots/manager.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/manager.ts) | The server's side: states, restart, resume and the adapter table |
| [`apps/server/src/adapters/bot-processes.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/bot-processes.ts) | Starting and killing bot processes with Bun |
| [`apps/server/src/adapters/adapter-launcher.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/adapter-launcher.ts) | The launcher that makes an adapter process non-dumpable |
