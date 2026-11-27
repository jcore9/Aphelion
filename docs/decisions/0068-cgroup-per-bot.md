# 0068. Each adapter run gets its own cgroup, which only a small supervisor can write

- Status: Proposed
- Date: 2026-11-27
- Proposed by: the #216 design, in the PR that adds this record
- Answers: how a cancel or a stop of a bot leaves no process of that bot alive ([#216](https://github.com/jcore9/Aphelion/issues/216))
- Amends: [decision 0045](0045-no-bot-namespaces-default-seccomp.md), which left the Compose security options at `no-new-privileges` only, and the container's [Hardening](../reference/container.md#hardening) table

## Context

A bot's AI tool runs shell commands. A command can start a daemon with `setsid`, or with a double fork, so that its parent exits and the container's first process adopts it. The bot runner shipped in [#215](https://github.com/jcore9/Aphelion/issues/215) kills a bot by walking its process tree through parent links. That walk misses every process whose parent already exited. The #215 trace measured this in the shipped container: a kill of the bot's process group left 4 of 6 test processes alive. A tree walk that freezes and rescans finds them, but it can't tell one bot's orphans from another's, and a fork loop that is faster than the scan can still slip past it.

Linux cgroups solve this. Every child a process starts lands in its parent's cgroup, and writing `1` to the cgroup's `cgroup.kill` file kills every process in it at once. In the trace, one write killed 64 processes, including `setsid` daemons and a live fork loop, in under 100 ms. A sibling cgroup kept all its processes.

Docker mounts the container's `/sys/fs/cgroup` read-only. The option `writable-cgroups=true` makes it writable. The owner approved that option on 2026-11-26. A writable cgroup v2 mount without `CAP_SYS_ADMIN` doesn't open the cgroup v1 `release_agent` hole (CVE-2022-0492) that decision 0045 lists.

The trace also measured the catch. If the bots' own user can write the tree, a bot can move its processes out of its cgroup, and the kill misses them. So a bot must not be able to write any cgroup file, and the process that writes them must not share a user with the bots or read their output.

## Options

| Option | For | Against |
| --- | --- | --- |
| Keep the tree walk | No Compose change | Misses orphans, can't tell bots apart, races a fork loop |
| A supervisor process per bot that adopts the bot's orphans | Tells bots apart | One more Bun process per bot. Still a tree walk, with its race. |
| A cgroup per run, written by the bots' user | One write kills everything | A bot can move itself out, measured |
| A cgroup per run, written only by a supervisor with its own user | One write kills everything, and no bot can escape | Two new users, one process with two capabilities, `writable-cgroups` in Compose |

## Decision

Each adapter run gets its own cgroup. A small process, the **cgroup supervisor**, is the only writer of the tree.

| User | Process | Capabilities | Cgroup rights |
| --- | --- | --- | --- |
| `root` | `tini` and the launcher | The container's three, at start only | Builds the tree once, places the supervisor and the bot runner, then hands the tree over |
| `aphelion-cgroups` (new, 10005) | The cgroup supervisor | Only `CAP_SETUID` and `CAP_SETGID`, used to switch each new adapter to `aphelion-bot` | The only writer of `/sys/fs/cgroup/bots/`, through the `aphelion-cgroups` group |
| `aphelion-runner` (new, 10006) | The bot runner, which reads the bots' output | None | None |
| `aphelion-bot` | Every adapter and every tool it starts | None | None |
| `harness` | The server | None | None |

These rules follow:

- The tree is `/sys/fs/cgroup/bots/`, with `system/runner`, `system/supervisor` and one leaf `work/<run id>` per adapter run. The run id is a UUIDv7. No controller is turned on below `bots/`.
- The supervisor reads only the bot runner's requests, over a private pipe that the launcher makes. A request names an adapter by a key in a fixed table, never by a path. The supervisor checks every run id, and finds a run to kill only in its own list of live runs.
- An adapter process writes its own process id into its leaf before it runs anything else, through a root-owned entry script. Only then does it open its pipes and switch to `aphelion-bot` with no groups, no capabilities and `no_new_privs`.
- A kill waits until the run's process has confirmed its placement or has exited. Then the supervisor writes `cgroup.kill`, waits for `populated 0`, and removes the leaf. A failed removal keeps the bot stopped, with one fixed log line.
- A cancel first asks the adapter to end the turn, for at most the runtime's 5-second cancel limit. Then the bot runner kills the run and starts a fresh adapter that resumes the session.
- At start, the supervisor runs one fake bot through the real start and kill, and checks each step. If one step fails, no bot starts, and the server logs one fixed line that names the step and the error code. `sudo aphelion check` runs the same check.
- The bot runner moves off `aphelion-bot`, so a bot can't signal or stop it. The run folders with each run's pipes are open only to the supervisor and the bot runner, through the `aphelion-runs` group (10007).

What stays: Docker's default seccomp profile, no extra namespaces, and Codex without its own sandbox, as decision 0045 says. Bots still share one user ([decision 0006](0006-shared-bot-user.md)), so a bot can still signal another bot's processes. Separate users per bot are later work.

## Consequences

- Compose gains `writable-cgroups=true` and a memory folder `/run/aphelion-runs`. The image gains two users and a group. `deploy/test/image-contract.sh` and `aphelion check` check both.
- The host's Docker must support `writable-cgroups`, and the host must use cgroup v2. Docker 29.10 supports it. Earlier versions, rootless Docker and `userns-remap` weren't tested. The [install guide](../guides/install.md) says so and shows the error.
- A command that a bot left running in the background dies when the bot stops, when a turn is cancelled, and when the adapter exits.
- The bot's folder is created as `/var/lib/aphelion-bots/<bot>`. A folder elsewhere in `bots.yaml` isn't created for the bot.
- Per-bot limits ([#47](https://github.com/jcore9/Aphelion/issues/47)) and per-plugin limits can build on the same tree. That needs a controller turned on below `bots/`, which this record doesn't do.
- Revisit when bots get separate users, or when a host can't offer `writable-cgroups`.
