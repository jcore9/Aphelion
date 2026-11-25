# M0-18 finding: per-bot isolation with user namespaces

- Issue: [M0-18](https://github.com/jcore9/Aphelion/issues/124)
- Date: 2026-11-22. Sources were read and every test ran on this date (UTC).
- Tested with: Docker 29.10.0, the `ubuntu:26.04` image (26.04.1), `bubblewrap` 0.11.1 (`0.11.1-1ubuntu0.3`), `unshare` from util-linux 2.41.3, Claude Code 2.1.330, Codex CLI 0.171.0 and Grok Build 1.0.92. The host was Debian 13 on kernel 6.5.13-3-pve, inside an unprivileged LXC container on Proxmox.
- Prototype: `spikes/M0-18/` on the [`spike/M0-18-namespaces-prototype`](https://github.com/jcore9/Aphelion/tree/spike/M0-18-namespaces-prototype/spikes/M0-18) branch, with the run logs in `runs/`. That branch is never merged.
- Decisions: [0006](../decisions/0006-shared-bot-user.md), [0016](../decisions/0016-one-docker-container.md), [0022](../decisions/0022-bot-network-boundary.md), [0035](../decisions/0035-codex-login-sandbox-approvals.md). This finding settles nothing itself. The owner answered its questions on 2026-11-22, and [decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md) records the answers.

Each answer is labeled **measured** (run on this box), **documented** (read in a source, which is linked), or **inferred** (reasoned from the two).

## Summary

The bot runner can start each bot in its own namespaces inside the hardened container, and a bot then sees only its own folder. The seccomp profile needs five more system calls than Docker's default: `clone` and `unshare` with namespace flags, `mount`, `umount2` and `pivot_root`. Killing the bot's `bwrap` process killed every process the bot had started, including one that had left its process group. Today's plan, which kills the process group, missed two of five.

Three costs go beyond what decision 0035 assumed:

- **A private `/proc` needs `systempaths=unconfined`.** Docker hides parts of `/proc`, and the kernel then refuses to mount a fresh `/proc` for a bot. Claude Code's own sandbox needs that fresh `/proc` inside a bot. The Docker option that allows it turns off those hidden paths for the whole container, not only for bots.
- **Codex's and Claude Code's sandboxes need network namespaces.** A profile without them still isolates bots, but neither CLI's own sandbox starts. A network namespace makes the kernel's firewall code (netfilter) reachable. Three of the privilege-escalation bugs in the list below are in that code, including one that ransomware has used.
- **On Ubuntu, Docker's AppArmor profile denies `mount`.** So `bwrap` would fail there even with the seccomp profile. The container needs its own AppArmor profile, which the host loads. This box runs no AppArmor, so the exit-test VM must measure it.

Grok Build's sandbox couldn't be tested, because this kernel has no Landlock. Without a real login, no CLI's token refresh could be tested. With dummy files, a shared login file mounted into a bot as a single file can be read and overwritten, but it can't be replaced by renaming. Codex 0.171.0 saves its login by renaming, and failed that way. It worked when `auth.json` was a link into a shared login folder.

## Terms

- **Namespace.** A Linux feature that gives a process its own private copy of one kind of system resource. A **mount namespace** gives it its own list of mounted folders, so it can see a different file tree. A **PID namespace** gives it its own process list, starting at 1. A **network namespace** gives it its own network interfaces and firewall rules.
- **User namespace.** A namespace for user IDs and privileges. Inside one, a process can be "root" with every capability, but only over the namespaces it owns. Outside, it is still the same ordinary user. An unprivileged process needs one before it can create the other kinds.
- **Capability.** One slice of root's power, such as `CAP_SYS_ADMIN` (mount filesystems and much more) or `CAP_NET_ADMIN` (change firewall rules).
- **seccomp.** A Linux filter that lists which system calls a process may make. Docker applies a default list to every container.
- **AppArmor.** A Linux security module that limits what each program may do, through a profile per program. Ubuntu turns it on. Docker gives each container a profile called `docker-default`.
- **`bwrap` (bubblewrap).** A small program that starts another program in new namespaces with a chosen file tree. Codex and Claude Code use it for their own sandboxes, and the runner would use it for bots.
- **`/proc`.** A folder the kernel fills with live information about every process. A bot needs its own `/proc` to see only its own processes.
- **Bind mount.** Making a folder or file appear at a second path. Through a bind mount, a bot sees exactly the folders the runner gives it.

## How the tests ran

- **The container.** Every test used `checks/run.sh`. It starts the `ubuntu:26.04` image with decision 0016's hardening: `--read-only`, `--cap-drop ALL` with only `SETUID` and `SETGID` added back, and `no-new-privileges`. It also sets a process and memory limit and gives `/tmp` a tmpfs. The container starts as root and switches to `aphelion-bot` (uid 10001) with `setpriv`, the way the init starts the runner. From there the process had no capabilities: `CapEff` was 0 (measured).
- **The bot sandbox.** `checks/botwrap.sh` is what the runner would run for one bot. It calls `bwrap` with new user, PID, IPC and hostname namespaces, `--die-with-parent` and `--new-session`. It makes `/usr` and `/etc` read-only and gives the bot a fresh `/dev` and `/tmp`. Under `/var/lib/aphelion-bots` it mounts only the bot's own folder, plus any folder the runner grants. The bots root was a Docker volume, as in decision 0016.
- **Seccomp profiles.** `seccomp/docker-29.10.0-default.json` is Docker's built-in profile, taken from moby tag `docker-v29.10.0` (the running daemon's commit, `06db173`). That tag vendors `github.com/moby/profiles/seccomp` v0.3.0. `seccomp/make-profiles.py` adds rules to it to make each variant.
- **The CLIs.** The installed CLI packages were mounted read-only at `/opt/cli`. Every home was a scratch folder. No real `~/.claude`, `~/.codex` or `~/.grok` was mounted, copied or read.
- **No logins.** Claude Code ran a real tool call against `checks/mock_anthropic.py`, a local stand-in for the Messages API, with the dummy key `sk-dummy-m018`. The egress test pointed each CLI's API address at `https://example.com`. Codex saved a dummy API key to test how it writes its login file.
- **This box differs from the target.**
  - The host is Debian 13, not Ubuntu 26.04, and has no AppArmor in Docker (`docker info` lists only seccomp and cgroupns). Question 3 is answered from documents.
  - The box is itself an unprivileged LXC container (root maps to uid 100000). So files the real host's root owns, such as `/proc/sys/kernel/core_pattern`, show up as owned by `nobody`. What container root could write under `systempaths=unconfined` can't be measured here.
  - The kernel is 6.5.13 (March 2024), with Landlock not enabled (measured: `EOPNOTSUPP`). Ubuntu 26.04 ships a newer kernel.

## Answers

### 1. Can the runner start each bot in its own namespaces

Yes, with a custom seccomp profile (measured). As `aphelion-bot` with no capabilities:

| Profile | `unshare -U` | `bwrap` with user namespace | Fresh `/proc` in a PID namespace |
| --- | --- | --- | --- |
| Docker default | "Operation not permitted" | "No permissions to create a new namespace" | fails |
| Default plus the namespace calls (question 4) | works | works | "Can't mount proc on /newroot/proc: Operation not permitted" |
| Plus `--security-opt systempaths=unconfined` | works | works | works |
| `seccomp=unconfined` | works | works | fails the same way |

Docker's default profile allows the namespace calls only to a container that keeps `CAP_SYS_ADMIN`, and 0016 drops it (documented: rule 44 of the default profile, `"includes": {"caps": ["CAP_SYS_ADMIN"]}`).

**The `/proc` problem.**

- Docker hides parts of `/proc`. It mounts empty files or folders over `/proc/kcore`, `/proc/keys`, `/proc/timer_list` and four others. It makes `/proc/sys`, `/proc/sysrq-trigger` and three more paths read-only (measured, from `/proc/self/mountinfo`).
- The kernel refuses a new `/proc` mount inside a user namespace when the existing `/proc` has hidden parts. This is a kernel rule (inferred from the measurement: the mount fails with every seccomp profile, and works once the hidden paths are gone).
- Docker's `--security-opt systempaths=unconfined` is the only switch that removes them. The Docker docs describe it as: "Turn off confinement for system paths (masked paths, read-only paths) for the container" ([docker container run](https://docs.docker.com/reference/cli/docker/container/run/), no date shown). It applies to the whole container: the server, the broker and the plugin runner too.

There are three ways to give a bot a `/proc`. All three were measured:

| Bot's `/proc` | Needs | Bot sees | Nested sandbox inside the bot |
| --- | --- | --- | --- |
| Fresh, in its own PID namespace | `systempaths=unconfined` | Only its own processes (4 entries) | Works: plain `bwrap`, Codex's and Claude Code's |
| The container's `/proc`, bind-mounted, with a PID namespace | Nothing more | Every process in the container, with command lines | Codex's works. Plain `bwrap` and Claude Code's fail: "open /proc/3/ns/ns failed" |
| The container's `/proc`, with no PID namespace | Nothing more | Every process in the container | Codex's works. Claude Code's works only with `enableWeakerNestedSandbox`. Kill doesn't reach the whole tree (question 6) |

**What a bot sees.** With the fresh `/proc` and the recommended profile (measured, `runs/recommended-profile.txt`):

- `ls /var/lib/aphelion-bots` showed only `a`. Reading bot `b`'s file failed: "No such file or directory".
- The bot had no capabilities outside its namespace (`CapEff` 0, `NoNewPrivs` 1), and its uid stayed `aphelion-bot`.
- `/proc` held 4 process entries: the bot's own.
- A nested user and mount namespace started inside the bot and listed only the bot's own tree. The unmount in that test failed ("not mounted"), so the log doesn't show that an unmount can't bring the outside tree back. That is not tested.

### 2. Do the three CLIs run inside it

Each binary starts inside a bot's namespaces (measured): `claude --version` printed "2.1.330 (Claude Code)", `codex --version` printed "codex-cli 0.171.0", and `grok version` printed "grok 1.0.92", with `GROK_SANDBOX=off`. Grok's sandbox itself didn't start (below). `codex login status` said "Not logged in", and `claude auth status` said `"loggedIn": false`.

**Their own sandboxes.** Codex was measured with a command that writes in the working folder, writes in the bot's home, and opens a connection. Claude Code was measured with writes only. Its connections were not tested.

| CLI | Directly in the container | Inside a bot, fresh `/proc` | Inside a bot, container's `/proc` |
| --- | --- | --- | --- |
| Codex 0.171.0, `codex sandbox -c sandbox_mode=workspace-write` | Starts. Cwd write works, home write "Read-only file system", network "Operation not permitted" | Same | Same |
| Claude Code 2.1.330, `sandbox.enabled`, one Bash call from the mock | Fails: "Can't mount proc on /newroot/proc" | Starts. Cwd write works, home write "Read-only file system". Network not tested | Fails, with the weaker mode on: "open /proc/34/ns/ns failed". Without it: not run |
| Claude Code, plus `sandbox.enableWeakerNestedSandbox` | Starts, with the container's `/proc` | Not run | Starts when the bot has no PID namespace. Fails with one (the row above) |
| Grok 1.0.92, strict sandbox (the log shows the strict profile refused) | Refuses to start: "Landlock not available ... Refusing to start with its protections missing". Under Docker's default profile it failed earlier, in `bwrap` | Same | Not run |

- **Codex falls back.** It tries to mount a fresh `/proc` first, and when that fails it reuses the caller's (documented: `run_bwrap_with_proc_fallback` and `preflight_proc_mount_support` in [`linux-sandbox/src/linux_run_main.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/linux-sandbox/src/linux_run_main.rs) at tag `rust-v0.171.0`).
- **Claude Code fails closed.** When its sandbox couldn't start, the Bash call failed and the command never ran outside the sandbox (measured, with `sandbox.failIfUnavailable` set).
- **Grok also uses `bwrap`.** Under Docker's default profile, Grok failed earlier, on "No permissions to create a new namespace". Its embedded docs say the sandbox uses "Landlock on Linux", and its binary also carries "bubblewrap needs unprivileged user namespaces" (both read in the 1.0.92 binary). Whether Grok's sandbox starts inside a bot is **not determined**. It needs a kernel with Landlock, which the exit-test VM has to provide.
- **Codex and Claude Code need network namespaces.** With a profile that refuses `CLONE_NEWNET`, both sandboxes failed: "No permissions to create a new namespace" (measured). Question 4 covers what that costs.

**Egress.** On a Docker `--internal` network, with M0-17's logging CONNECT proxy as the only way out, and `HTTPS_PROXY` and `NO_PROXY` set on the container (measured, `runs/q2-egress.txt`):

- The proxy variables reached the process inside the bot unchanged, because the bot shares the container's network.
- `curl` through the proxy got 200, and `curl --noproxy '*'` failed to resolve the host.
- Claude Code, Codex and Grok each reached `example.com:443` through the proxy, and got `example.com`'s 405 back. Codex also opened `api.github.com` and `codeload.github.com`, as M0-17 found.

**Shared login files.** Decision 0006 keeps one login per provider in the `aphelion-bot` home. With per-bot namespaces, the runner would mount those files into each bot. Tested with dummy files only (measured, `runs/q2-creds.txt`):

| Mounted as | Read | Overwrite in place | Replace by rename | Delete |
| --- | --- | --- | --- | --- |
| One file (`--bind auth.json`) | works | works | "Device or resource busy" | "Device or resource busy" |
| The folder that holds it | works | works | works | Not tested |

- **Codex replaces its login by renaming** (documented: `storage_file.rs` in [`login/src/auth`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/login/src/auth/storage_file.rs), "Atomic credential-file replacement"). It writes a temporary file beside the target and renames it over `auth.json`. It follows a link first, and takes a lock file, `auth.json.lock`, beside the real file.
- **Measured with Codex.** `codex login --with-api-key`, given a dummy key, failed on a single-file mount: "Error logging in: Resource busy (os error 16)". It worked when `$CODEX_HOME/auth.json` was a link into a shared login folder that the bot had mounted. The shared file then held the new value, plus `auth.json.lock`.
- **Claude Code refuses a linked login file** (inferred from its binary, which has a `refused-symlink` state for `.credentials.json`). Whether it writes by renaming is not determined. Its write path calls a helper whose code couldn't be traced in the minified binary.
- **Grok.** Not determined.
- **Not tested without a real login:** a real token refresh for any of the three, and Codex's ChatGPT WebSocket through the proxy. The exit-test VM needs a login for each CLI to test them.

### 3. Does AppArmor on Ubuntu block it

Not measured. This box runs no AppArmor. Two separate AppArmor rules apply on an Ubuntu host, and **the exit-test VM must measure both**.

**Docker's own profile denies `mount`.** The `docker-default` profile at Docker 29.10.0 contains `deny mount,` and `umount,` (documented: the template in `vendor/github.com/moby/profiles/apparmor/template.go` at moby tag `docker-v29.10.0`, saved in the prototype as `seccomp/docker-29.10.0-apparmor-template.go.txt`). Docker applies that profile to every container on a host with AppArmor, unless the Compose file names another. `bwrap` calls `mount` to build the bot's file tree, so it would fail (inferred). The same template pins `abi <abi/3.0>`.

**Ubuntu restricts user namespaces.**

- Ubuntu 23.10 added the sysctl `kernel.apparmor_restrict_unprivileged_userns` ([Ubuntu blog, 9 October 2023](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)). The [24.04 LTS release notes](https://documentation.ubuntu.com/release-notes/24.04/) (no date shown) say the kernel "now restricts" user namespaces, after 23.10 "where it was not enabled by default".
- The 24.04 notes say: "This affects all programs on the system that are unprivileged and unconfined." Such a program may create a user namespace, but the default profile "will deny the subsequent use of any capabilities within the user namespace". `bwrap` needs those capabilities to mount the bot's file tree.
- The blog describes the rule for confined programs: they "will only be able to create user namespaces if they are confined and have the 'userns,' rule in their AppArmor profile (or if they have CAP_SYS_ADMIN)." A container under `docker-default` is confined.
- The sysctl is one setting for the whole host. [Understanding AppArmor User Namespace Restriction](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007) (27 March 2025) gives the background.
- The [26.04 release notes](https://documentation.ubuntu.com/release-notes/26.04/) (23 April 2026) don't mention the restriction on their main page. So its 26.04 default is not determined.

**The fix can be scoped to the container (inferred).**

- **What the profile does.** A custom AppArmor profile for the Aphelion container would allow `mount` and `userns,`. It would keep the rest of `docker-default`. The Compose file attaches it with `security_opt: apparmor=<name>`.
- **How the host loads it.** The host loads the profile with `apparmor_parser -r -W <file>`, as [Docker's AppArmor page](https://docs.docker.com/engine/security/apparmor/) describes (no date shown). Loading it is a step on the host, but it affects only containers that name it.
- **What it avoids.** The host-wide alternative is `kernel.apparmor_restrict_unprivileged_userns=0`, which lifts the restriction for every program on the host. The profile avoids that.
- **What is unknown.** Whether `docker-default`'s `abi/3.0` exempts containers from the `userns` check is not determined.

The exit-test VM needs:

- the value of `kernel.apparmor_restrict_unprivileged_userns`;
- the error from `bwrap` in the hardened container under `docker-default`;
- whether a container profile with `mount` and `userns,` fixes it;
- the exact profile text.

### 4. What does the profile add

**The exact difference from Docker's default** at 29.10.0 is one added rule (measured, `runs/profile-diff.txt`):

```json
{
	"names": ["clone", "unshare", "mount", "umount2", "pivot_root"],
	"action": "SCMP_ACT_ALLOW",
	"comment": "M0-18: namespace calls for bwrap, without CAP_SYS_ADMIN"
}
```

The default already allows `clone` without namespace flags, and returns "not implemented" for `clone3` to a container without `CAP_SYS_ADMIN`. The C library then falls back to `clone`, which the new rule covers. The default allows `unshare`, `setns`, `mount`, `umount2`, `pivot_root`, `fsopen`, `fsconfig`, `fsmount`, `move_mount`, `open_tree` and `mount_setattr` only with `CAP_SYS_ADMIN` (documented, the default profile).

**What each call is for** (measured, `runs/q4-minimal.txt`):

| Left out | Result |
| --- | --- |
| `pivot_root` | `bwrap: pivot_root: Operation not permitted` |
| `umount2` | `bwrap: unmount old root: Operation not permitted` |
| `mount` | `bwrap: Failed to make / slave: Operation not permitted` |
| `setns` | Nothing failed: bots, Codex's sandbox and Claude Code's sandbox all started. So the profile leaves `setns` out. |
| `CLONE_NEWNET` (any other namespace flag allowed) | Bots start. Codex's and Claude Code's sandboxes don't. |

The new mount API (`fsopen`, `fsconfig`, `fsmount`, `move_mount`, `open_tree`, `mount_setattr`) stays blocked, and `bwrap` 0.11.1 didn't need it.

**What it exposes.** `cap_drop: ALL` doesn't limit a process inside a new user namespace. There it has every capability (measured: `CapEff` was `000001ffffffffff` inside `unshare -Ur`). Those capabilities apply only to the namespaces it owns, but they reach kernel code that Docker's default profile keeps away from the container:

- **Mounting.** With `CAP_SYS_ADMIN` over its own mount namespace, a process can mount the filesystem types that allow it inside a user namespace, such as tmpfs, proc, overlayfs and cgroup.
- **Networking.** With `CAP_NET_ADMIN` in a new network namespace, it can set netfilter firewall rules and traffic control.

These are the known classes of privilege-escalation bug reached that way, from the issue's list and two more:

| CVE | Code | Reached through | Status |
| --- | --- | --- | --- |
| [CVE-2022-0185](https://ubuntu.com/security/CVE-2022-0185) | Filesystem context, `legacy_parse_param` | A user and mount namespace. Ubuntu: "in case of unprivileged user namespaces enabled, otherwise needs namespaced CAP_SYS_ADMIN". The public exploits call `fsconfig` ([Qualys on oss-security, 25 January 2022](https://openwall.com/lists/oss-security/2022/01/25/14)). | `fsconfig` stays blocked by the recommended profile. Fixed upstream by commit `722d94847de2` (Ubuntu published 18 January 2022). |
| [CVE-2021-22555](https://ubuntu.com/security/CVE-2021-22555) | netfilter `x_tables` | A user and network namespace: "through user name space" | Reachable only if network namespaces are allowed. Ubuntu published 7 July 2021. |
| [CVE-2023-32233](https://ubuntu.com/security/CVE-2023-32233) | netfilter `nf_tables` | A user and network namespace. Ubuntu's mitigation: "disable the ability for unprivileged users to create namespaces" | Same. Ubuntu published 8 May 2023. |
| [CVE-2024-1086](https://nvd.nist.gov/vuln/detail/CVE-2024-1086) | netfilter `nf_tables` | A user and network namespace | Same. In CISA's Known Exploited Vulnerabilities catalog since 30 May 2024 (NVD), and [reported](https://securityaffairs.com/184076/security/old-linux-kernel-flaw-cve-2024-1086-resurfaces-in-ransomware-attacks.html) in ransomware attacks in 2025. Fixed after commit `f342de4e2f33` ([Ubuntu](https://ubuntu.com/security/CVE-2024-1086), published 31 January 2024). |
| [CVE-2023-0386](https://ubuntu.com/security/CVE-2023-0386) | overlayfs | `mount` of overlayfs in a user namespace | Reachable with `mount` allowed. Ubuntu published 22 March 2023. |
| [CVE-2023-2640](https://ubuntu.com/security/CVE-2023-2640), [CVE-2023-32629](https://ubuntu.com/security/CVE-2023-32629) | overlayfs, Ubuntu's own patches | Same | Reachable with `mount` allowed. Ubuntu published 6 June 2023. |
| [CVE-2022-0492](https://ubuntu.com/security/CVE-2022-0492) | cgroup v1 `release_agent` | Mounting a writable cgroup v1 hierarchy in a user namespace. [Unit 42](https://unit42.paloaltonetworks.com/cve-2022-0492-cgroups/): "Since Seccomp blocks the unshare() syscall, only containers running without Seccomp can create a new user namespace", and AppArmor blocked the mount step too. | Reachable with `mount` allowed. Docker's AppArmor `deny mount,` is the other blocker today, and the custom AppArmor profile in question 3 would remove it. Ubuntu published 8 February 2022. |

All of these are fixed in current kernels. The risk is the next bug of the same kind, on a host that hasn't installed the fix yet. Decision 0035 already requires the host's kernel security updates.

**`systempaths=unconfined` is a second cost.** It unhides `/proc/kcore`, `/proc/keys`, `/proc/timer_list` and the others, and makes `/proc/sys` and `/proc/sysrq-trigger` writable mounts, for every process in the container (measured: the masks disappear from `mountinfo`). File permissions still apply. Bots run as uid 10001, so they couldn't read `/proc/kcore` or write `/proc/sys` (measured). But in a Docker container without user remapping, uid 0 is the real host root. Only the init runs as uid 0 in 0016's design. A root process with no capabilities may still write some `/proc/sys` files, such as `kernel.core_pattern`, which runs a program as host root (inferred, not measured, because this box maps container root to 100000). The exit-test VM should check what uid 0 can write under this option. M0-12 should make sure no uid 0 process stays running after start-up if the option is used.

**Recommended profile.** Docker's default plus the one rule above (`seccomp/userns-nosetns.json` on the prototype branch). It is the smallest set that runs bots, Codex's sandbox and Claude Code's sandbox together. Refusing `CLONE_NEWNET` removes the netfilter bugs above, at the price of Codex's and Claude Code's own sandboxes. That trade, and `systempaths=unconfined`, are security calls for the owner.

### 5. Could namespaces replace the shared-folder risk

For files, yes (measured, `runs/q5-isolation.txt`, fresh `/proc`):

| From bot `a` | Result |
| --- | --- |
| List `/var/lib/aphelion-bots` | Only `a` |
| Read `b`'s file by path | "No such file or directory" |
| Read `b`'s file through `/proc/<b's pid>/root` | "No such file or directory": `b`'s processes aren't in `a`'s `/proc` |
| Signal `b`'s process by pid | `kill` said "No such process". A probe that passed a `/proc/<pid>` directory descriptor to `pidfd_send_signal` failed with "No such file or directory". That descriptor isn't a real pidfd, so only `kill` is a valid result. |
| A manager bot granted `b`'s folder | Listed `b` and its own folder, read `b`'s file, and wrote one |
| The same manager bot, reading `a`'s folder | "No such file or directory" |

With the container's `/proc` shared instead, bot `a` could list every process in the container and read their command lines. It still couldn't read `b`'s files through `/proc/<pid>/root` or its environment ("Permission denied"), or signal it. `kill` said "No such process" (measured). The probe with a `/proc/<pid>` directory descriptor gave "Invalid argument", but it wasn't a real pidfd, so it proves nothing about signaling. Codex's source names the same protection: a separate user namespace "blocks host procfs root/cwd/fd links through ptrace permission checks" ([`bwrap.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/linux-sandbox/src/bwrap.rs) at `rust-v0.171.0`).

**A manager bot.** The runner bind-mounts each folder that the manager's config grants, as in `checks/botwrap.sh mgr b`. Config is owned by `harness` and unreadable to bots (decision 0010), so a bot can't grant itself another folder.

**What stays shared** (measured unless marked):

- **The network.** Bots share the container's network, so they can reach each other's local ports and abstract Unix sockets. Bot `a` bound an abstract socket in the shared namespace.
- **The shared logins.** Every bot that mounts a provider's login folder can read that login, as today.
- **Same uid on the volume.** Files a bot writes are owned by `aphelion-bot`, as today. The runner, outside any namespace, can still reach every folder.
- **Bugs that defeat namespaces.** A kernel bug, or a runner bug in the mount list, puts a bot back where decision 0006 is today (inferred). It doesn't give the bot more than that, because the other boundaries don't depend on namespaces.

**The four fixed users all stay** (inferred). Namespaces replace only the idea of one Unix user per bot. Every bot's namespaces are created by `aphelion-bot`, so they separate bots from each other only.

- `harness` keeps the config, the database and the audit log out of bots' reach.
- `aphelion-secrets` keeps the broker's store out of reach.
- `aphelion-plugins` keeps plugins apart from bots and the server (decision 0018).

The real uids and file modes on the volumes do that work, whatever happens inside a namespace.

**One gain for decision 0035.** The runner can mount `$CODEX_HOME/rules` read-only, or not at all. 0035 needs bots unable to write there, because a user `allow` rule silences `untrusted` (inferred).

### 6. Does it keep decision 0022's "ready for option 2" rules

Yes (measured for kill; inferred for the rest).

**Kill.** A bot started five `sleep` processes: one in the background, a daemon with its own child that left the process group with `setsid`, one under `nohup`, and the main one. The runner then sent SIGKILL (measured, `runs/q6-kill.txt`):

| How the bot was started | What the runner killed | Left running |
| --- | --- | --- |
| Plain child, no namespaces (today's plan) | The process group | 2 of 5 |
| Plain child, no namespaces | The bot's main process | 4 of 5 |
| `bwrap`, PID namespace, `--die-with-parent` (`botwrap.sh`) | The `bwrap` process | 0 |
| `bwrap`, PID namespace, `--die-with-parent` | The runner itself | 0 |
| `bwrap`, PID namespace, no `--die-with-parent` | The `bwrap` process | 5 of 5 |
| `bwrap`, no PID namespace, `--die-with-parent` | The `bwrap` process | 4 of 5 |

Killing the bot's first process inside its PID namespace kills every process in that namespace. `--die-with-parent` makes that happen when the runner kills `bwrap` or dies itself. Both are needed. Decision 0016's "cancel kills the bot's whole process group" missed the two processes that left the group.

**The other rules.**

- **Process control.** It still goes only through the runner. The runner holds the `bwrap` process for each bot. The server never sees a bot's process ids, so it needs no `/proc` access.
- **Moving to option 2.** The namespaces live inside whichever container runs bots, so moving bots to their own container doesn't change them.
- **Egress.** Bots share the container's network, so `HTTPS_PROXY` and `NO_PROXY` still set their only route out (measured in question 2).

## What changes depending on the answer

| Finding | Consequence | This finding |
| --- | --- | --- |
| The runner can isolate each bot, all three CLIs run, and the profile adds only what `bwrap` needs | A new decision record amends 0006 once the owner approves it. M1-04 starts bots in their own namespaces. M0-12 ships the profile and any host AppArmor change, in place of M4-10. | The runner can, and all three binaries run. The seccomp profile adds only `bwrap`'s calls. But a private `/proc` needs `systempaths=unconfined`, and Grok's sandbox is not determined. |
| Codex's sandbox starts, but per-bot isolation doesn't work for every CLI | 0006 stands. The profile serves Codex only. | Doesn't apply. Every CLI ran inside a bot. |
| Codex's sandbox doesn't start inside a bot's namespace | Say whether the bot's namespace can stand in for Codex's sandbox. | Doesn't apply. It started in all three `/proc` setups. |
| The profile needs more than the namespace and mount calls, or its attack surface is larger than decision 0035 assumed | **Stop.** The owner decides whether 0035's profile stands. | **Applies.** Network namespaces are needed for Codex's sandbox, which brings netfilter into reach. A private `/proc` needs `systempaths=unconfined`. |
| AppArmor blocks it, and only a host-wide change fixes it | **Stop.** The owner decides whether the install guide makes that change. | Not determined. `docker-default` denies `mount`. A container-scoped profile looks possible. The exit-test VM measures it. |
| It breaks a "ready for option 2" rule | Propose a runner design that keeps the rule. | Doesn't apply. Kill reaches the whole tree. |

## Questions for the owner

**Answered on 2026-11-22.** The owner chose no per-bot isolation (question 3), no `systempaths=unconfined` (question 1) and no network namespaces (question 2). Codex then runs without its own sandbox, and the container goes back to Docker's default seccomp profile. [Decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md) records this. The questions stay below as they were asked.

1. **A private `/proc` for each bot.** Should the container run with `systempaths=unconfined`, which unhides parts of `/proc` and `/sys` for every process in it? It gives each bot a private process list, and Claude Code's own sandbox can then run inside a bot. The other way, bots share the container's `/proc`. They then see every process's command line, but not its files or environment. Claude Code then runs without its own sandbox inside a bot, or with its weaker mode and no PID namespace for that bot.
2. **Network namespaces.** Should the profile allow them? Codex's and Claude Code's own sandboxes need them. They also bring the netfilter code into reach of every process in the container. Three bugs in the list above are in that code, one of them used in ransomware attacks.
3. **Per-bot isolation.** If you choose to go ahead, a new decision record would amend 0006. Each bot would see only its own folder, plus folders its config grants. M0-12 would ship the profile, and M1-04 would start bots this way.

**Historical.** These were the checks the exit-test VM would have needed before M0-12 shipped the per-bot design. The owner rejected that design ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)), so they are no longer prerequisites for M0-12. Only the Landlock check still matters, for Grok in M4-01.

What the exit-test VM would have had to provide:

- An Ubuntu 26.04 host with Docker 29.10.0, to measure the AppArmor answers in question 3 and what uid 0 can write under `systempaths=unconfined`.
- A kernel with Landlock, to see whether Grok's sandbox starts inside a bot.
- A login for each CLI, to see whether a token refresh writes through the shared login folder.

## Downstream changes

**Superseded by the owner's answers.** The table below is what the finding proposed if the owner said yes. [Decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md) lists the changes that apply: no seccomp profile to ship, 0006 stays, and cancel uses the measured result, with the process-group gap open for M1-04.

| Issue or decision | Change |
| --- | --- |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | Waits on the owner's questions. If yes: ship the recommended seccomp profile, `bubblewrap` from Ubuntu (not setuid), the `systempaths` choice, and a container AppArmor profile that the host setup loads. If `systempaths=unconfined` is chosen, leave no uid 0 process running after start-up. The exit test adds the isolation, kill and AppArmor checks from the prototype. |
| [M1-04](https://github.com/jcore9/Aphelion/issues/22) | Start each bot through `bwrap` with new user, PID, IPC and hostname namespaces, `--die-with-parent` and `--new-session`. Mount the bot's folder, the folders its config grants, and a shared login folder per provider. Cancel by SIGKILL to the `bwrap` process, not the process group. Even without per-bot isolation, a process group misses daemons, as question 6 measured. |
| [M4-10](https://github.com/jcore9/Aphelion/issues/114) | Codex's sandbox runs inside a bot. The profile needs `CLONE_NEWNET` for it. `$CODEX_HOME/auth.json` is a link into the shared login folder, never a single-file mount. Mount `$CODEX_HOME/rules` read-only. |
| [M2-05](https://github.com/jcore9/Aphelion/issues/31) | Where bots have namespaces, the runner mounts Codex's rules folder and every hook file read-only inside each bot. |
| [Decision 0006](../decisions/0006-shared-bot-user.md) | Amended by a new decision record only if the owner says yes to question 3. |
| [Decision 0016](../decisions/0016-one-docker-container.md) | "Cancel kills the bot's whole process group" misses processes that leave the group. Cancel kills the bot's PID namespace instead. |
| [Decision 0035](../decisions/0035-codex-login-sandbox-approvals.md) | The narrow profile is now measured: one rule with five calls, plus network namespaces for Codex's sandbox, plus a container AppArmor profile on Ubuntu. |
| [Decision 0022](../decisions/0022-bot-network-boundary.md) | No change. Bots share the container's network, and option 2 moves their namespaces with them. |
