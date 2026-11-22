# 0045. Bots get no namespaces of their own, the container keeps Docker's default seccomp profile, and Codex runs without its own sandbox

- Status: Accepted
- Date: 2026-11-22
- Decided by: project owner
- Answers: the three questions for the owner in the [M0-18 finding](../spikes/M0-18-namespaces.md#questions-for-the-owner)
- Amends: [0035](0035-codex-login-sandbox-approvals.md) (the sandbox and seccomp parts), [0016](0016-one-docker-container.md) (cancel)
- Keeps: [0006](0006-shared-agent-user.md)

## Context

[Decision 0035](0035-codex-login-sandbox-approvals.md) planned a custom seccomp profile so Codex's own sandbox could run inside the container. It also asked whether the same feature could isolate each bot from the others. The [M0-18 spike](https://github.com/jcore9/Aphelion/issues/124) measured both. This record settles the three questions it left for the owner.

Four terms, in plain words:

- **System call.** A request that a program makes to the Linux kernel, such as "open this file" or "start a process".
- **seccomp.** A Linux filter that lists the system calls a process may make. Docker applies a default list to every container. Anything off the list fails.
- **Namespace.** A private copy of one part of the system. A **user namespace** gives a process its own idea of who is root. A **mount namespace** gives it its own file tree. A **PID namespace** gives it its own process list. A **network namespace** gives it its own network interfaces and firewall rules.
- **`/proc`.** A folder the kernel fills with live facts about every running process.

What the spike found ([full finding](../spikes/M0-18-namespaces.md)):

- **It can be done.** The agent runner can start each bot in its own namespaces, and a bot then sees only its own folder. Claude Code, Codex and Grok all start inside one.
- **The profile is small.** Docker's default seccomp profile needs one added rule with five system calls: `clone`, `unshare`, `mount`, `umount2` and `pivot_root`.
- **A private `/proc` has a price.** Docker hides parts of `/proc`. The kernel then refuses to give a bot a fresh one. The only fix is `--security-opt systempaths=unconfined`, which unhides those parts for every process in the container.
- **The two CLI sandboxes need more.** Codex's and Claude Code's own sandboxes need network namespaces. Those put the kernel's firewall code within reach of every process in the container.
- **Cancel is weak today.** Killing a bot's process group left 2 of 5 of its processes running. Killing the `bwrap` process of a bot with its own PID namespace left none. `bwrap` is the small program that starts a process in new namespaces.
- **Ubuntu adds a step.** Docker's AppArmor profile denies `mount`, so the container would also need its own AppArmor profile. This was not measured, because the test box has no AppArmor.

## Options

The owner answered four choices on 2026-11-22. Costs come from the finding.

**1. Per-bot isolation.**

| Option | For | Against |
| --- | --- | --- |
| Isolate each bot with user, mount and PID namespaces | A bot sees only its own folder, plus folders its config grants. Cancel reaches the whole process tree. | The five extra system calls. A host AppArmor profile on Ubuntu. Login files need care: Codex saves its login by renaming a file, which fails on a single-file mount. A new decision amends 0006. |
| Keep bots shared, as 0006 says | No new kernel exposure. Nothing to build. | Any bot can read and write any other bot's folder and see its processes. 0006 already accepted that, so the owner can read it as a feature, not a gap. |

**2. A private `/proc` for each bot.**

| Option | For | Against |
| --- | --- | --- |
| `systempaths=unconfined` | Each bot sees only its own processes. Claude Code's own sandbox runs inside a bot. | Unhides `/proc/kcore`, `/proc/keys` and others, and makes `/proc/sys` writable, for the whole container. File permissions still apply. A root process may write `kernel.core_pattern`, which runs a program as host root. Not measured, because the test box maps container root to uid 100000. |
| Keep Docker's hidden paths | Nothing changes. | A bot can't have a private `/proc`. |

**3. Network namespaces.**

| Option | For | Against |
| --- | --- | --- |
| Allow them | Codex's and Claude Code's own sandboxes start. | The kernel's firewall code (netfilter) becomes reachable from every process in the container. Three of the bugs the spike listed are in it: CVE-2021-22555, CVE-2023-32233 and CVE-2024-1086. CVE-2024-1086 is in CISA's list of exploited bugs and was used in ransomware attacks. |
| Refuse them | Removes those bugs from reach. | Neither CLI's own sandbox starts. |

Mounting brings another class of bugs into reach if `mount` is allowed: CVE-2022-0185 (the `fsconfig` call, which the recommended profile kept blocked), CVE-2023-0386, CVE-2023-2640 and CVE-2023-32629 (overlayfs), and CVE-2022-0492 (cgroup `release_agent`). The finding has the full table. All are fixed in current kernels. The risk is the next bug of the same kind on a host that hasn't patched yet.

**4. Codex's sandbox and the container's seccomp profile.**

| Option | For | Against |
| --- | --- | --- |
| A custom profile, so Codex's own sandbox runs | One more layer around each Codex command. | Needs network namespaces (choice 3), and so the kernel exposure above, for every process in the container. |
| Docker's default profile, and Codex with its own sandbox off | No kernel exposure beyond Docker's default. Nothing else in Aphelion needs the extra system calls. | A Codex command has no sandbox around it. The container and the approvals are the only boundary. |

## Decision

On 2026-11-22 the owner chose:

1. **No per-bot isolation.** Bots stay shared, as [0006](0006-shared-agent-user.md) says.
2. **No `systempaths=unconfined`.** Bots don't get a private `/proc`. The container keeps Docker's hidden paths.
3. **No network namespaces.** The container gets no custom seccomp profile at all.
4. **The container goes back to Docker's default seccomp profile, and Codex runs without its own sandbox.** Codex's sandbox needs network namespaces, so it can't run, and nothing else needs the extra system calls.

Codex's commands are protected by these layers instead:

- the hardened container ([0016](0016-one-docker-container.md)): read-only root, no capabilities, `no-new-privileges`, process and memory limits;
- shared bots with no per-bot isolation ([0006](0006-shared-agent-user.md)), and the four fixed users that keep config, secrets and plugins out of reach;
- Aphelion's approvals: the `untrusted` policy on a pinned Codex version, with every escalation request going to the owner ([0035](0035-codex-login-sandbox-approvals.md));
- the managed hook, which fails closed;
- the proxy and the host firewall ([0022](0022-agent-network-boundary.md)).

## Consequences

**This record amends [0035](0035-codex-login-sandbox-approvals.md).** Two of its parts change:

- **The container no longer allows user namespaces.** 0035 gave the container a custom seccomp profile for them. The container now runs Docker's default profile. M0-12 ships no seccomp file. There's no host AppArmor change either, because nothing in the container calls `mount` or creates a namespace.
- **Codex runs with its own sandbox off.** 0035 said `requirements.toml` allowed only `read-only` and `workspace-write`, and kept `danger-full-access` out. That is reversed. In Codex's settings, `sandbox_mode` is the sandbox choice, and `danger-full-access` means no sandbox. The M0-17 finding showed that `allowed_sandbox_modes` holds: a value outside the list fell back to an allowed mode when it came from `config.toml` or `thread/start`, and was rejected when it came from `turn/start`. So:
  - `/etc/codex/requirements.toml` sets `allowed_sandbox_modes = ["danger-full-access"]`. The other mode lists from 0035 stay the same.
  - Each thread starts with `sandbox: "danger-full-access"`. With `danger-full-access` the only allowed value, nothing can switch the sandbox on or to another mode.
  - M0-17 measured the list with `read-only` and `workspace-write` as the allowed values. It didn't measure a list with `danger-full-access` alone. M4-10 must measure that before it ships, and must confirm that `untrusted` still asks for every command with the sandbox off.

**What still makes every Codex command ask.** Turning the sandbox off doesn't turn approvals off. Two checks stay as 0035 wrote them:

- **The `untrusted` policy.** Every shell command and file change asks the adapter. The adapter sends each one to the policy engine. Approvals are answered with `accept`, `decline` or `cancel` only.
- **The managed hook.** It runs before every local tool call and fails closed, with a deadline shorter than Codex's own timeout.

**Escalation requests.** An escalation request is Codex asking to run a command outside its sandbox. With no sandbox there is nothing to leave, so Codex should not send many of them. The owner's rule from 0035 stands unchanged. If Codex sends one, the adapter sends it to the owner, with the exact command. No policy rule and no reviewer model may approve it. M4-10's tests keep covering this.

**What the owner gives up.** In 0035, a sandbox stood between a Codex command and the container's files. Now an approved command can write anywhere the `aphelion-agent` user can, including other bots' folders and its own login files. The owner approves each command, so the owner's attention is now the main limit on Codex. A prompt-injected Codex that asks for a harmful command is stopped only if the owner declines it.

**This record keeps [0006](0006-shared-agent-user.md).** All bots share the `aphelion-agent` user. 0006 needs no "Amended by" line.

**It changes three issues.** Each gets an amendment note that links this record.

| Issue | Change |
| --- | --- |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | No seccomp profile to ship. The Compose file keeps Docker's default and never sets `seccomp=unconfined`. No `systempaths` option. No AppArmor profile or host AppArmor step. `bubblewrap` isn't needed in the image. |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | No profile to ship. Ships the pinned `codex` binary and the `/etc/codex` files, with the sandbox settings above. Measures the two open points above. |
| [M1-04](https://github.com/jcore9/Aphelion/issues/22) | Bots start as plain child processes of the runner, with no `bwrap`. Cancel uses what the spike measured, and has an open problem below. |

**An open risk for cancel (M1-04).** The spike measured that killing a bot's process group left 2 of 5 processes running. A process that calls `setsid` leaves the group, and a daemon can outlive the cancel. Killing only the bot's main process left 4 of 5. The fix the spike measured, a PID namespace with `--die-with-parent`, is now ruled out. M1-04 must find another way to stop every process a bot started. The finding names these starting points:

- **A cgroup per bot.** A cgroup is a Linux group of processes with shared limits. Killing the cgroup kills every process in it, wherever it went. Whether the container can create cgroups under Docker's default profile and the hardened settings is not measured.
- **`bwrap --die-with-parent` without a new PID namespace.** The spike measured 4 of 5 left running in that setup, but it also needs the namespace calls, so it is unlikely to work without the extra profile. Treat it as unproven.
- **Tracking descendants.** The runner walks the bot's child processes and kills each one. This is racy, because a process can fork between the walk and the kill.

M1-04 measures these and picks one. If none reaches every process, the owner decides whether the residual risk is acceptable. [Decision 0016](0016-one-docker-container.md)'s line, "cancel kills the agent's whole process group", stays wrong until then.

**Costs the spike measured that no longer apply.** No AppArmor profile on Ubuntu hosts, no uid 0 process rule for `systempaths`, and no single-file login mount problem. Codex's rename-based login saves keep working on `$CODEX_HOME` as today.

**Not decided here.** Whether Grok's sandbox starts is still not determined. Grok needs a kernel with Landlock, and it doesn't need this record's choices.

**Revisit this when:**

- the owner wants bots kept apart from each other, for example once bots serve other people or a plugin runs untrusted bots. The spike's prototype is the starting point;
- the exit-test VM or a later spike shows a way to isolate bots without network namespaces or `systempaths=unconfined`;
- bots move to their own container ([0022](0022-agent-network-boundary.md) option 2). A profile then applies to that container only, and not to the server or the broker;
- Codex ships a sandbox that doesn't need network namespaces;
- a Codex incident shows that the approvals and the container are not enough.
