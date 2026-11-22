# 0046. The plugin runner adopts every process its plugins leave behind, and freezes then kills a plugin's whole process tree

- Status: Proposed
- Date: 2026-11-22
- Proposed by: the M0-13b PR ([#100](https://github.com/jcore9/Aphelion/issues/100))
- Answers: how the plugin runner stops a plugin and all its children, without namespaces ([decision 0045](0045-no-bot-namespaces-default-seccomp.md))

## Context

The plugin runner must stop a plugin and every process the plugin started. The [M0-18 finding](../spikes/M0-18-namespaces.md) measured the plan's method, which kills the process group. It missed 2 of 5 processes, because a process can leave its group with `setsid` or a double fork.

M0-18 also measured a method that works: start each bot in its own PID namespace through `bwrap`, and kill the namespace. [Decision 0045](0045-no-bot-namespaces-default-seccomp.md) then chose Docker's default seccomp profile and no namespaces. That profile blocks the system calls `bwrap` needs. So the plugin runner needs a third way.

Some words used below:

- A **process tree** is a process, its children, their children, and so on. Linux records each process's parent.
- An **orphan** is a process whose parent died. Linux gives it a new parent, normally the container's init.
- A **child subreaper** is a process that asks Linux, with `prctl(PR_SET_CHILD_SUBREAPER)`, to become the new parent of orphans from below it, instead of init.
- **Freezing** a process means sending it `SIGSTOP`. A frozen process can't fork.
- A **PID** is the number Linux gives a process. Linux reuses the number after the process is gone. The **start time** in `/proc/<pid>/stat` (field 22) tells two processes with the same PID apart.

## Options

| | Kills all 5 test processes | Works with Docker's default setup | Cost |
| --- | --- | --- | --- |
| Kill the process group | No, 2 of 5 left (M0-18, measured) | Yes | None |
| Kill a PID namespace made by `bwrap` | Yes (M0-18, measured) | No. The default seccomp profile blocks `unshare` and `mount` ([0045](0045-no-bot-namespaces-default-seccomp.md)) | Reverses 0045 |
| Put each plugin in its own cgroup and write `cgroup.kill` | Not tried | No. In a default container `/sys/fs/cgroup` is read-only, and `mkdir` there fails with `Read-only file system` (measured, Docker 29.10.0) | Needs a writable cgroup from the host |
| Runner is a child subreaper, and freezes then kills the tree | Yes, 5 of 5 (measured, see below) | Yes | Detached processes can't be told apart, see below |

The measurement is the test `runs a real plugin, keeps its folder read-only and its environment clean, and kills its whole tree` in [`runner-process.test.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/plugins/runner-process.test.ts). It runs the real runner and a real plugin under Bun 1.4.5. The plugin starts the same five `sleep` processes as M0-18: a plain child, a `setsid` daemon with its own child, a double-forked `setsid` child, and one under `nohup`. All five are alive while the plugin runs, and none is alive after the host stops the plugin.

## Decision

The runner makes itself a child subreaper when it starts. So every process that leaves a plugin's tree becomes a child of the runner, and the runner can find it in `/proc`.

To stop a plugin, the runner:

1. Collects the plugin's process tree and every orphan it has adopted, from the parent of each process in `/proc`. It records each process as its PID and start time.
2. Freezes each process it found with `SIGSTOP`.
3. Collects again, and freezes the new processes, until a pass finds no new process.
4. Kills every frozen process with `SIGKILL`.
5. Waits up to 2 seconds for each process to be gone. It logs an error with the number of processes that are still there.

Before each signal, the runner reads the start time again. If it changed, the PID belongs to a new process, and the runner doesn't send the signal.

An orphan carries no mark of the plugin it came from. So the runner treats every orphan as a process to kill:

- Stopping any plugin also kills every orphan.
- Every 10 seconds, the runner kills every orphan.

A plugin can still start child processes that stay attached to it. It can't run a detached daemon.

Only the runner reads `/proc` and sends signals. The server still goes through the runner, as [decision 0022](0022-agent-network-boundary.md) requires. The `prctl` and `waitpid` calls go through `bun:ffi`, in [`plugin-processes.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/adapters/plugin-processes.ts), the one file where Bun-only code is allowed ([decision 0023](0023-scaffold-toolchain.md)).

## Consequences

- Plugin authors must keep child processes attached. [Running plugins on the server](../reference/plugins.md#child-processes) says so.
- The cleanup is best effort, for these reasons:
  - Linux delivers `SIGSTOP` a moment after the runner sends it. A process can fork in that moment, after the runner's last pass. The fork becomes an orphan when its parent is killed, and the next 10-second sweep kills it.
  - A PID can be reused between the runner's check of the start time and its signal. The window is a few microseconds. Only a `pidfd`, a file handle that names one process, closes it. Bun has no `pidfd` call yet.
  - The runner reports processes that didn't go away in time as an error in its log. It still tells the host that the plugin stopped. It waits at most 5 seconds for the plugin's own process to exit after the kill, so one stuck process can't hold up stopping other plugins.
- Stopping one plugin kills the detached processes of every plugin, because an orphan carries no mark of its plugin. A plugin can use that to disrupt another plugin.
- The runner depends on Linux and on `libc.so.6`. Aphelion supports only Linux on the server ([decision 0011](0011-ubuntu-lts.md)).
- Every plugin runs as the same user, so a plugin can send signals to another plugin's processes. This method doesn't change that. [Decision 0045](0045-no-bot-namespaces-default-seccomp.md) accepted it.
- The agent runner has the same problem in M1-04 ([#22](https://github.com/jcore9/Aphelion/issues/22)). It may reuse this method. M1-04 decides.
- Revisit this decision if the owner adds per-plugin namespaces or cgroups. Killing a namespace or a cgroup replaces the tree walk, and plugins could then run detached daemons.
