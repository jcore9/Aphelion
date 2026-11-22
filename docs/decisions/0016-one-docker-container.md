# 0016. The headless server ships as one Docker container, with separate users inside

- Status: Accepted
- Date: 2026-11-21
- Decided by: project owner
- Amended by: [decision 0022](0022-agent-network-boundary.md) (the host firewall is the network boundary, and every API endpoint except `/health` needs a token, even on loopback)
- Amended by: [decision 0018](0018-shared-plugin-user.md) (a fourth user, `aphelion-plugins`, and a plugin runner)
- Amended by: [decision 0017](0017-desktop-remote-only.md) (the desktop app only connects to a server; local mode is dropped)
- Amends: [0006](0006-shared-agent-user.md) (how agents are started), [0009](0009-electron-desktop-shell.md) (desktop local mode), [0010](0010-agent-folders.md) (per-agent systemd units), [0012](0012-secrets-broker-process.md) (where the broker runs), [0014](0014-filesystem-layout.md) (where the paths live)
- Amended by: [0035](0035-codex-login-sandbox-approvals.md) (the container's seccomp profile allows user namespaces, so Codex's sandbox runs)
- Amended by: [0045](0045-no-bot-namespaces-default-seccomp.md) (reverses that: the container keeps Docker's default seccomp profile)

## Context

With a server user, a shared agent user and a secrets user on the host, the install script, systemd units and polkit rules had become the most complex part of M0. The owner proposed shipping the server as a container instead.

## Options

1. **Three containers** (server, agents, secrets), each seeing only its own storage. The container boundaries would replace the users, and a runner in the agents container would start agents on the server's request.
2. **One container with the users inside it.** Everything in one image, with the same three users and permissions as before, created by the image instead of an install script.
3. **Stay on the host**, as decided in 0006 to 0014.

For the engine, the options were Docker with Compose, or rootless Podman with systemd Quadlet units. For desktop local mode, the options were running everything as the desktop user, creating the same users through the `.deb` installer, or dropping local mode.

## Decision

Option 2, on **Docker with Compose**. Desktop local mode runs everything as the **desktop user**.

**The image.**

- Based on the current Ubuntu LTS ([decision 0011](0011-ubuntu-lts.md)).
- Contains the Bun-compiled server, the secrets broker, the agent runner, pinned versions of the Claude Code and Grok Build CLIs, and git.
- The managed CLI settings and the fail-closed hooks (`/etc/claude-code/`, `/etc/grok/`) are baked into the image, owned by root. The root filesystem is mounted read-only, so no process in the container can change them.

**The users inside**, with fixed UIDs:

| User | Runs |
| --- | --- |
| `harness` | The server |
| `aphelion-agent` | The agent runner and every agent ([decision 0010](0010-agent-folders.md)) |
| `aphelion-secrets` | The secrets broker ([decision 0012](0012-secrets-broker-process.md)) |

**How processes start.**

- A small init process is PID 1. It runs as root only to start three long-lived processes, each as its own user: the server, the broker and the agent runner. The init tool is chosen in M0-12.
- The **agent runner** replaces the per-agent systemd units from 0006 and 0010. It already runs as `aphelion-agent`, so it starts agents as its own child processes, with no privileges needed.
- The server tells the runner to start, stop or cancel an agent over a Unix socket. The runner checks the caller's UID (`SO_PEERCRED`) and accepts only `harness`, so an agent can't use the runner to start or stop other agents.
- Cancel kills the agent's whole process group. *Amended by [0045](0045-no-bot-namespaces-default-seccomp.md): a process group misses processes that leave it, so M1-04 must find a cancel that leaves none alive.*

**Storage.** The paths from [decision 0014](0014-filesystem-layout.md) stay the same, but they're now Docker volumes mounted at those paths inside the container, with the same owners and modes. `/tmp` is a tmpfs.

**Hardening in the Compose file:**

- `read_only: true`, `no-new-privileges`, and `cap_drop: ALL`, adding back only what the init needs to start processes as other users (`SETUID` and `SETGID`, plus anything M0-12 shows is required).
- A process limit, and memory and CPU limits for the container.
- Never `privileged`, and **never a mount of the Docker socket**, which would hand root on the host to whoever can reach it.

**The host** (Ubuntu LTS) runs Docker Engine with the Compose plugin and Tailscale.

- A host systemd unit, `aphelion.service`, starts the Compose project on boot. It loads the bootstrap secret with `LoadCredentialEncrypted=` and passes it to the container as a Compose secret, mounted readable only by `aphelion-secrets`.
- The server's port is published only on the host's tailnet address (for example `100.x.y.z:7400:7400`). `aphelion config check` refuses a Compose file that publishes it on any other address.
- Nobody is added to the `docker` group, because that's equivalent to root. Admins run Compose with sudo.

**Desktop local mode** runs the same server binary directly, with no container, and everything runs as the logged-in desktop user. The app shows a persistent banner while local mode is on. It says that agents there can read and change the approval rules and the secrets store, so approvals are advisory, and it points to the headless server for real work.

## Consequences

- **Install is simpler.** The host needs Docker, Tailscale, the Compose file and `aphelion.service`, and upgrading means pulling a new image. Users, ownership and modes are fixed in the image, so they can't drift on a host.
- **Isolation inside the container is the same as before.** Agents can't read the config, the database or the secrets store, or change the hooks.
- **Docker adds its own risk.** Docker's daemon runs as root, so a container escape matters more than it would under rootless Podman. The hardening above and the hypervisor-level LAN firewall from the plan are the mitigations. Rootless Docker can be evaluated later as its own decision.
- **Per-agent CPU and memory limits** (M4-04) no longer come from systemd. Options are cgroup v2 delegation inside the container, or per-process resource limits from the runner; M4-04 decides. Limits on the container as a whole work from day one.
- **Tailscale identity** ([decision 0013](0013-tailscale-identity.md)): the container doesn't get the host's Tailscale socket, so M0 is likely token-only, plus binding to the tailnet address. M0-10 (b) confirms.
- **Desktop local mode is weaker by design.** It needs no setup, but it gives no protection against a tricked agent. That trade is visible in the UI at all times.
- **M0-03** no longer needs to prove "no GUI libraries" on a bare host; the image proves it. It still checks the SDKs on Bun, the compiled binary inside the image, and Electron starting the binary for local mode.
- **Issue changes:** M0-03, M0-10, M0-11, M0-12 (rewritten as the image, the Compose file and the host unit), M0-14, M1-04 (the runner), M2-05 (hooks baked into the image), M4-04 and M5-15.
