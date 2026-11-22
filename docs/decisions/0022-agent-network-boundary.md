# 0022. The host firewall blocks the container from the LAN, with a path to a separate agents container

- Status: Accepted (approved by merging #111 on 2026-11-22)
- Date: 2026-11-21
- Decided by: project owner (option 1 now, ready for option 2)
- Amends: [0016](0016-one-docker-container.md) (network boundary, API exposure inside the container, runner channels), [0010](0010-agent-folders.md) (how the server reads agent files), [0018](0018-shared-plugin-user.md) (the plugin runner channel)
- Amended by: [0035](0035-codex-login-sandbox-approvals.md) (the option 2 egress allowlist adds `api.openai.com`, `chatgpt.com` and `auth.openai.com`)

## Context

An adversarial review of the M0-03 prototype ran two independent reviewers (Claude Haiku 5.5 and Grok 4.7 Fast) against the hardened container, and every finding below was rerun before it was kept. File isolation held. Four findings did not:

1. **Agents aren't blocked from the LAN.** As `aphelion-agent`, one TCP connect each succeeded to the LAN gateway (`10.0.0.1:80`), the host's LAN address (`10.0.0.133:22`), the host's tailnet address (`100.71.226.67:22`), another tailnet device (`100.93.139.95:22`), the Docker bridge (`172.17.0.1:22`) and the internet (`1.1.1.1:443`). The plan's first enforcement layer is "the host firewall blocks the LAN". 0016 relied on a hypervisor firewall that the container setup doesn't provide. Inside one container, every process shares one network, so agents can't be given tighter network rules than the server.
2. **Every user in the container reaches the server API on loopback.** `127.0.0.1:7400/health` returned `200` to `aphelion-agent` and `aphelion-plugins`. The server must listen on all interfaces inside the container, so "bind to the tailnet only" holds only for the published port.
3. **The server follows symlinks that agents plant.** An agent linked its instructions file to `/etc/aphelion/policy.json`. The agent got `Permission denied`, and the server read the policy through the link. 0010 has the server read instruction files and hand them to the CLIs, which would leak the content back.
4. **Neither Node nor Bun reads Unix socket peer credentials.** Node 24 and Bun 1.4.5 sockets expose only `_getpeername`, so the `SO_PEERCRED` checks in 0016 and 0018 can't be built.

## Options

For the network boundary:

1. **Host firewall, one container.** The host setup installs rules in Docker's `DOCKER-USER` chain that drop the container's traffic to private ranges, the tailnet range and the host, and allow the internet.
2. **A separate agents container** on an internal network, with an egress proxy that allows only the provider APIs. Stronger: agents could reach only Anthropic and xAI.
3. **A dedicated VM** with the hypervisor firewall from the plan.

## Decision

**Option 1 now. The design stays ready for option 2.**

**The network boundary (option 1).**

- The host setup (M0-12) installs `DOCKER-USER` rules for the Aphelion bridge network. They drop traffic to `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (the tailnet), link-local, and the host's own addresses, except replies to connections that clients opened to the published port. Everything else, which includes the provider APIs, is allowed.
- The Compose file pins the bridge network's name and subnet, so the rules can match it.
- The rules live on the host, out of reach of anything in the container. The exit test repeats the six connects above and requires the first five to fail.
- The server's own outbound traffic follows the same rules. That's acceptable, because the server needs the internet (provider APIs, and GitHub until the M3 gateway exists) and not the LAN.

**The server API inside the container.**

- Every endpoint except `/health` requires a valid device token, including requests from `127.0.0.1`. `/health` returns only `{"status":"ok"}`.
- Nothing else in the container listens on TCP.

**Reading agent files.**

- The server reads anything under `/var/lib/aphelion-agents` only through one helper. The helper opens each path component with `O_NOFOLLOW`, rejects anything that isn't a regular file, and checks that the resolved path stays inside that agent's folder.
- A lint rule bans other file reads under the agents root.

**Runner channels.**

- The server talks to the agent runner and the plugin runner over pipes that the init creates before it drops privileges, the same way it hands over the bootstrap secret ([0021](0021-container-init-and-secret-handoff.md)). No socket in the filesystem, and no peer-credential check.

**Ready for option 2.** These rules keep a later move to a separate agents container a deployment change, not a redesign:

- **One channel type.** The server reaches the agent runner only through a framed message stream. Today it's a pipe. Across containers it becomes a Unix socket on a shared volume, authenticated with a per-boot token from the init, because peer credentials aren't available.
- **No shared-namespace shortcuts.** The server never reads agent processes through `/proc`, never signals agent PIDs directly, and never assumes it shares a network or PID namespace with agents. Starting, cancelling and killing go through the runner.
- **Proxy-aware egress.** Agent processes get their outbound route only from the standard proxy environment variables (`HTTPS_PROXY`, `NO_PROXY`), unset today. Option 2 points them at the egress proxy.
- **Files through volumes only.** The server and the agents share files only through the agents volume, so that volume can be mounted into two containers.
- **Triggers to move.** Move to option 2 when any of these holds: agents need an allowlist of outbound hosts, for example to stop exfiltration by a prompt-injected agent; the host firewall rules can't be installed or kept in place; or more than one host runs agents.

## Consequences

- The exit test (M0-12) gains the network checks, and the install guide documents the rules.
- Agents can still reach any internet host. Only option 2 narrows that, and the triggers above say when.
- Any host that runs Docker for Aphelion must allow the setup to manage `DOCKER-USER`. The install guide warns that other tools editing that chain can break the boundary, and the exit test catches it.
- The issues change as listed in the downstream table in the [M0-03 finding](../spikes/M0-03-headless-on-bun.md#review-findings).
