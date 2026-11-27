# The bot runner

The **bot runner** starts and stops the bots. It is one process, `bot-runner.js`, that runs as the `aphelion-runner` user. For each bot it runs one **adapter** process, the code that drives the bot's AI tool ([bot adapters](bot-adapters.md)). The server never starts, signals or reads a bot process itself. It sends the bot runner a message, and the bot runner does the work.

The bot runner doesn't start adapters itself either. It asks the **cgroup supervisor**, a second small process, to start each adapter in a cgroup of its own and to kill that cgroup when the bot stops or a turn is cancelled. [The cgroup supervisor](#the-cgroup-supervisor) explains why.

## How the server and the bot runner talk

The [launcher](container.md#how-the-processes-start) creates two pipes for the bot runner, as it does for the plugin runner. A pipe is a one-way channel between two processes. The bot runner reads requests on its standard input and writes replies on its standard output. The server holds the other ends as descriptors 5 and 6 (`--bot-runner-fds 5,6`). No other process holds them, and no file leads to them.

Each message is one JSON object on one line, at most 8 MiB. Every message names the bot and a **run** number. The server counts runs up by one for each start of a bot. The bot runner ignores a message for a run that isn't the bot's current one.

| From | Message | What it does |
| --- | --- | --- |
| Server | `start` | Starts the bot's adapter with the bot's provider, adapter name, folder and the session to resume, or `null`. The adapter name is a key in the supervisor's adapter table, such as `claude`, never a path. |
| Server | `turn.start` | Sends the bot one prompt, at most 256 KiB |
| Server | `turn.cancel` | Cancels the turn, then replaces the adapter ([how a cancel works](#how-a-cancel-works)) |
| Server | `stop` | Stops the bot |
| Bot runner | `spawned` | The adapter process started |
| Bot runner | `started` | The adapter answered `initialize` for the right provider |
| Bot runner | `start-failed` | The process didn't start (`stage: "spawn"`), the adapter refused `initialize` (`stage: "initialize"`), or the supervisor's start check failed (`stage: "cgroups"`) |
| Bot runner | `turn.accepted`, `turn.refused` | The adapter's answer to `turn.start`. A refusal is `not-running`, `busy`, `ended`, `too-long` or `refused`. |
| Bot runner | `event` | One event from the adapter, as [the adapter wire](bot-adapters.md#on-the-wire) shapes it |
| Bot runner | `log` | One line the adapter wrote to its standard error |
| Bot runner | `notice` | A note from the bot runner about the adapter, as a code: `line-too-long`, `not-a-message`, `stopped-reading` or `too-much-log` |
| Bot runner | `exited` | The adapter process ended without a stop, with its exit code or signal |
| Bot runner | `stopped` | The stop finished |

The bot runner checks every line from an adapter against the adapter wire, and drops a line that doesn't fit and sends a `notice` with code `not-a-message`. It never reads a bot id from an adapter. It tags each message with the bot it started that process for.

The bot runner holds at most 4 MiB of one adapter's output that it hasn't handled yet. When an adapter writes faster than the bot runner can pass its messages on, the bot runner stops reading that adapter until the backlog drains. The adapter then waits on its own writes. This is called back-pressure. It keeps one bot's flood from filling the bot runner's memory, and the other bots' messages keep moving.

## The cgroup supervisor

A **cgroup** (control group) is a Linux kernel feature that groups processes. Every process belongs to exactly one cgroup, and every child a process starts lands in the same cgroup. A process can't leave its cgroup unless it may write to the cgroup files. Writing `1` to a cgroup's `cgroup.kill` file kills every process in it at once, including processes that started a new session with `setsid`, or that a double fork handed to the container's first process. A kill that follows parent links misses those, so the bot runner can't rely on one.

Aphelion gives each adapter run its own cgroup. The tree lives at `/sys/fs/cgroup/bots/` in the container:

| Path | Holds | Who may write it |
| --- | --- | --- |
| `bots/system/runner/` | The bot runner | Only `root`, which places the runner at start |
| `bots/system/supervisor/` | The cgroup supervisor | Only `root`, which places the supervisor at start |
| `bots/work/<run id>/` | One adapter run and everything it starts. The run id is a UUIDv7. | The supervisor, which creates and removes it |

The launcher builds the tree once as `root`. The tree's `cgroup.procs` file and the `work/` folder go to the `aphelion-cgroups` group, which holds only the supervisor's user. No other file in the tree is writable by anyone but `root`, and no controller, such as a memory or CPU limit, is turned on below `bots/`. A bot can't create, move, freeze, kill or remove any cgroup.

The supervisor is `cgroup-supervisor.js`. It runs as `aphelion-cgroups` with exactly two capabilities, `CAP_SETUID` and `CAP_SETGID`. It uses them for one thing: to switch each new adapter process to the `aphelion-bot` user. It reads only the bot runner's requests, over a private pipe pair that the launcher makes, the same way as the server's pipes.

| From | Message | What it does |
| --- | --- | --- |
| Bot runner | `start` | Starts an adapter, with a new run id, the bot id and the adapter name |
| Bot runner | `kill` | Kills a run's cgroup and removes it |
| Supervisor | `ready`, `unsafe` | The start check passed, or failed at a named step with an error code |
| Supervisor | `started`, `start-failed` | The run started, with the paths of its three pipes, or didn't start |
| Supervisor | `exited` | The run's adapter process ended, with its exit code or signal |
| Supervisor | `killed`, `kill-failed` | The run's processes are gone and its cgroup is removed, or not |

The supervisor checks every request. A run id must be a UUIDv7, an adapter name must be in its table, and a bot id must be a bot id. It refuses a second `start` for a run it knows. A `kill` finds the run only in the supervisor's own list of live runs, so a request never names a path.

### How a run starts

1. The supervisor creates the run's cgroup and a run folder, `/run/aphelion-runs/<run id>/`. The folder holds three named pipes, `stdin`, `stdout` and `stderr`. Only the supervisor and the bot runner can open them, through the `aphelion-runs` group.
2. The supervisor starts `/usr/local/lib/aphelion/run-adapter`, a short script that only `root` can change. The script first writes its own process id into the run's `cgroup.procs`, and exits if it can't. It then tells the supervisor it is placed, opens the three pipes, and switches to `aphelion-bot` with no groups, no capabilities and `no_new_privs`. Last, it starts Bun with the adapter.
3. The supervisor replies `started` only after the script says it is placed. The bot runner then opens its ends of the pipes.

The adapter is in its cgroup before any of its code runs. Until it switches users, it runs as `aphelion-cgroups`, so no bot can signal it or read it.

### How a run is killed

On `kill`, the supervisor waits until the run's script has said it is placed, or has exited. Then it writes `1` to the run's `cgroup.kill`, waits until `cgroup.events` shows `populated 0`, and removes the cgroup and the run folder. It replies `killed` only then. Two kills of one run share one answer. A kill never holds up another run.

If the processes don't all exit within 5 seconds, or the cgroup can't be removed, the supervisor replies `kill-failed`. The bot runner logs `the cgroup supervisor couldn't remove the bot's processes, so the bot stays stopped`, with the bot and the reason. The bot then stays stopped: a later `start` for it fails with `the bot's last processes couldn't be removed`.

### The start check

When the supervisor starts, it runs one fake bot, the probe, through the same start and kill as a real bot. The probe adapter, `cgroup-probe.js`, only answers one request and then waits. The supervisor checks each step:

| Step | Passes when |
| --- | --- |
| `own-cgroup` | The supervisor itself sits in `bots/system/supervisor` |
| `start` | The probe run starts |
| `placed` | The probe's process id is in its run's `cgroup.procs` |
| `drop` | The probe runs as `aphelion-bot`, with no groups, no capabilities and `NoNewPrivs` |
| `bot-denied` | The probe, as `aphelion-bot`, gets `EACCES` or `EPERM` when it writes any file in the tree, creates a folder in it, or opens the run folder, while its own cgroup and run folder still exist |
| `kill` | The kill succeeds |
| `gone` | The probe has exited, and its cgroup and run folder are gone |

If every step passes, the supervisor logs `the cgroup check passed, so bots can start`. If one fails, it logs `the cgroup check failed, so no bot starts` with the step and the error code, and it refuses every start. The bot runner refuses too. For each bot, the server logs `bots can't start, because the cgroup check failed`, with the bot and the step, such as `own-cgroup: ENOENT`.

The usual cause is a Docker that doesn't allow writable cgroups ([the install guide](../guides/install.md)). `sudo aphelion check` runs the same check in the running container.

## What a bot process gets

The adapter process runs `bun --no-env-file --preload /usr/local/lib/aphelion/adapter-launcher.js <adapter file> <bot>`. The adapter launcher runs first in the same process. It sets the process non-dumpable, creates the bot's folder `/var/lib/aphelion-bots/<bot>` with mode `0750` if it is missing, and moves into it. Then Bun loads the adapter file ([how one bot is kept from another](#how-one-bot-is-kept-from-another)). The adapter learns the folder from `bots.yaml` in `initialize`. A folder in `bots.yaml` other than `/var/lib/aphelion-bots/<bot>` isn't created for it.

The process gets only its standard input, output and error, which are the run's three pipes. It gets this environment and nothing else:

| Variable | Value |
| --- | --- |
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | `/var/lib/aphelion-bots`, the `aphelion-bot` user's home. Every bot shares it, so they share one sign-in per AI tool ([decision 0006](../decisions/0006-shared-bot-user.md)). |
| `LANG` | `C.UTF-8` |
| `TZ` | `UTC` |
| `TMPDIR` | `/tmp` |
| `DISABLE_AUTOUPDATER` | `1`, for a `claude` bot only, so Claude Code doesn't update itself |

`HTTPS_PROXY` and `NO_PROXY` are never set. The bot's network goes out as the container's does ([decision 0022](../decisions/0022-bot-network-boundary.md)). A later proxy changes only these two variables.

The server picks the adapter name by the bot's `provider`, and the supervisor maps the name to a file and an environment from a fixed table. Today one name starts a bot: `claude` runs `/usr/local/lib/aphelion/adapters/claude/adapter.js`. The table's other entry, `probe`, is the start check's fake bot. A bot whose provider has no adapter doesn't start. The server logs `no adapter in this image runs the bot's provider, so the bot won't start` with the bot and the provider.

## How one bot is kept from another

Bots share the `aphelion-bot` user ([decision 0006](../decisions/0006-shared-bot-user.md)). The bot runner and the supervisor each have a user of their own, so a bot can't signal, stop or read either of them. Through the bot runner, a bot can't start, stop or send a prompt to another bot:

- A bot can't write to the server's pipe. It never gets the pipe as a descriptor.
- A bot can't open the run folders, so it can't open another bot's pipes by path.
- A bot can't open another bot's adapter descriptors. Linux lets a process open another process's descriptors through `/proc/<pid>/fd`, and read its memory and environment, when both run as the same user. A **non-dumpable** process (`PR_SET_DUMPABLE=0`) refuses that to everyone but `root`. Each adapter process sets itself non-dumpable, and so does the bot runner. Without this, one bot could read the prompts another bot gets, or write events the bot runner would take as the other bot's.
- A bot can't name another bot. The bot runner reads a bot's output as adapter messages only, and tags them itself.
- A message for one bot reaches only the process the bot runner started for that bot.

The adapter becomes non-dumpable twice over, so there's no moment when a sibling can open its pipes:

- The image installs `/usr/local/bin/bun` with mode `0711`: every user can run it, and only `root` can read it. Linux makes a process non-dumpable from its first instruction when it runs a program it can't read. This covers the time Bun takes to start, before any JavaScript runs. It also covers the bot runner, the plugin runner and every plugin.
- The launcher calls `PR_SET_DUMPABLE=0` itself before the adapter loads, in case a host's `fs.suid_dumpable` setting is `1`, which would leave the first step open.

The first step depends on a setting of the host's Linux kernel, `fs.suid_dumpable`. Containers share the host's kernel, so the image can't set it. The Linux default is `0`, and with `0` there's no gap. To check it on the host, run `sysctl fs.suid_dumpable`. It should print `fs.suid_dumpable = 0`. If it prints `1`, a new adapter process stays open to its siblings for a few milliseconds, from the moment Bun starts until the launcher runs. In that window another bot could open the new adapter's pipes. The value `2` behaves like `0` here. To set it back to `0`, run `sudo sysctl -w fs.suid_dumpable=0`, and remove any line that sets it to `1` from `/etc/sysctl.conf` or `/etc/sysctl.d/`.

Some things stay open under the shared user ([decision 0006](../decisions/0006-shared-bot-user.md)):

- A bot can still signal, and so stop, another bot's processes ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md), [decision 0068](../decisions/0068-cgroup-per-bot.md)). It can't signal the bot runner or the supervisor.
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

## How a cancel works

On `turn.cancel` for the turn that is open, the bot runner first sends the adapter `turn.cancel`. The adapter's runtime ends the turn within 5 seconds, usually with `turn.end` and reason `cancelled`. The bot runner waits for that `turn.end`, for at most 6 seconds. Then it asks the supervisor to kill the run, so every command the turn started dies with the adapter, including background commands and daemons. The bot runner finishes the stream as for a dead process: a call still open gets `tool.end` with outcome `cancelled`.

Next the bot runner starts a fresh adapter in a new run, with the bot's latest session as `resume`. The server sees no new start. The bot stays running, and the fresh adapter's events continue the same `seq` numbers. Until the fresh adapter has answered `initialize`, the bot runner refuses every new prompt for that bot with `busy`. If the fresh adapter fails, the bot runner sends `exited`, and the server restarts the bot.

A cancel kills only that bot's run. Every other bot keeps its processes.

## How a bot stops

On `stop`, the bot runner sends the adapter `shutdown` and gives it 5 seconds to exit. Then it asks the supervisor to kill the run, whether the adapter exited or not. Nothing the bot started survives the stop. An adapter that exits by itself gets the same kill before the bot runner sends `exited`, so a crashed bot leaves nothing behind either.

When the server stops, it stops every bot, with at most 15 seconds for all of them. The bot runner exits when the server closes the pipe, and kills any bot that is left. The supervisor then exits too, and kills any run that is left.

## Tests

- `apps/server/src/cgroups/supervisor.test.ts` runs the supervisor with a fake host. It checks the request checks (a run id that isn't a UUIDv7, an unknown adapter, a bad bot id, a second start, a kill for an unknown run), that `started` and the kill both wait for placement, that kills of one run share one answer and don't hold up another run, and that a failed start check at any step refuses every start.
- `apps/server/src/bots/runner.test.ts` runs the bot runner with the SDK's runtime and fake adapters in the same process. It checks a start, a turn and a stop, resume, the repaired stream, the isolation rules, the refusals, a cancel that replaces the adapter, a failed kill, and a failed start check.
- `apps/server/src/bots/runner-process.test.ts` runs the real bot runner over named pipes, with a test supervisor and a real Bun adapter. It checks that the adapter gets exactly the environment above, holds none of the runner's pipes, and can't read the bot runner's descriptors or environment, and that another process of the same user can't open the adapter's descriptors.
- `apps/server/src/bots/manager.test.ts` runs the server's bot manager against the bot runner. It checks restart with resume, giving up, the retry without a session, the folder check, an unknown provider, and the log line for a failed start check.
- [`deploy/test/image-contract.sh`](https://github.com/jcore9/Aphelion/blob/main/deploy/test/image-contract.sh) checks the shipped image with the Compose settings. The runner and the supervisor run as their own users in their own cgroups, the supervisor with only `CAP_SETUID` and `CAP_SETGID`. Through the real launcher, supervisor and runner, two fake adapter bots each start `setsid` and double-fork daemons and a fork loop. After a cancel and after a stop, a process listing as `root` shows none of that bot's processes, and the other bot keeps its own. Neither bot can write the cgroup tree or signal the runner or the supervisor. Without `writable-cgroups`, no bot starts and the server logs the fixed line. `aphelion check` runs the start check.

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/bots/runner.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/runner.ts) | The bot runner |
| [`apps/server/src/bots/runner-protocol.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/runner-protocol.ts) | The messages between the server and the bot runner |
| [`apps/server/src/bots/stream.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/stream.ts) | The stream repair |
| [`apps/server/src/bots/environment.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/environment.ts) | A bot's environment |
| [`apps/server/src/bots/manager.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/bots/manager.ts) | The server's side: states, restart, resume and the adapter table |
| [`apps/server/src/adapters/supervised-bot-processes.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/supervised-bot-processes.ts) | The bot runner's side of the supervisor's pipe, and each run's three pipes |
| [`apps/server/src/adapters/adapter-launcher.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/adapter-launcher.ts) | The launcher that makes an adapter process non-dumpable and moves it into its folder |
| [`apps/server/src/cgroups/supervisor.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cgroups/supervisor.ts) | The supervisor: request checks, live runs, placement, kill and the start check |
| [`apps/server/src/cgroups/protocol.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cgroups/protocol.ts) | The messages between the bot runner and the supervisor |
| [`apps/server/src/cgroups/table.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cgroups/table.ts) | The supervisor's adapter table |
| [`apps/server/src/adapters/cgroup-host.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/cgroup-host.ts) | The supervisor's file and process work: cgroups, run folders, the entry script |
| [`apps/server/src/adapters/cgroup-probe.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/cgroup-probe.ts) | The start check's fake bot |
| [`deploy/image/run-adapter`](https://github.com/jcore9/Aphelion/blob/main/deploy/image/run-adapter) | The entry script that places an adapter and switches it to `aphelion-bot` |
