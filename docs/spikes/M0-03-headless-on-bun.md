# M0-03 finding: headless without Electron, on Bun

- Issue: [M0-03](https://github.com/jcore9/Aphelion/issues/4)
- Date: 2026-11-21
- Tested with: Bun 1.4.5, Docker 29.10.0, Docker Compose 5.8.0, `ubuntu:26.04` (26.04.1 LTS), systemd 257, on a Debian 13 host with cgroup v2
- Prototype: `spikes/M0-03/` on the [`spike/M0-03-headless-on-bun`](https://github.com/jcore9/Aphelion/tree/spike/M0-03-headless-on-bun/spikes/M0-03) branch. That branch is never merged.
- Decision: [0021](../decisions/0021-container-init-and-secret-handoff.md) (proposed in this PR)

## Summary

The shape from decisions [0007](../decisions/0007-bun-runtime.md), [0016](../decisions/0016-one-docker-container.md) and [0018](../decisions/0018-shared-plugin-user.md) holds. A Bun-compiled binary runs in a hardened Ubuntu 26.04 image with no GUI libraries, and four users start from one init with only `SETUID` and `SETGID` added back. Every SDK the project depends on works on Bun.

Four details have to change, and decision 0021 proposes the changes:

- **The init is `tini` plus `setpriv`.** A Bun launcher drops supplementary groups, which breaks the server's read access to the bot folders.
- **Compose ignores a secret's `uid`, `gid` and `mode`.** The bootstrap secret therefore stays root-only, and the init hands it to the broker on stdin.
- **The 1Password SDK can't be compiled into a binary.** Plugins run from their installed package with the `bun` runtime, which the image ships.
- **Vitest needs `pool: "threads"` under `bun --bun`.**

## Answers

### 1. Does the compiled binary run in the hardened image

Yes (measured).

- `ldd` on the compiled binary lists only `libc`, `libpthread`, `libdl` and `libm`. There are no GUI libraries.
- The stub ran under `read_only: true`, `no-new-privileges:true`, and `cap_drop: [ALL]` plus `SETUID` and `SETGID`, with `pids_limit` and `mem_limit` set. `docker inspect` confirmed every setting, and showed no Docker socket mount.
- With the port published as `100.71.226.67:7400:7400`, `/health` answered `{"status":"ok"}` on the tailnet address. The LAN address (`10.0.0.133`) and `127.0.0.1` refused the connection.
- If the tailnet address doesn't exist yet, Docker fails to start the container: "failed to bind host port 100.71.226.99:7499/tcp: cannot assign requested address". The host unit has to wait for Tailscale before starting Compose.

### 2. Can one init start four processes as four users

Yes, with `tini` plus `setpriv` (measured). Two variants were built and compared.

| | Variant A: `tini` + `setpriv` script | Variant B: compiled Bun launcher with `spawn({ uid, gid })` |
| --- | --- | --- |
| Starts all four users with only `SETUID` and `SETGID` | Yes | Yes |
| Keeps supplementary groups (`harness` in group `aphelion-bot`) | Yes, with `--init-groups` | **No.** The children start with no supplementary groups. |
| Server can list `/var/lib/aphelion-bots` | Yes | No, `EACCES` |
| Root-owned code we maintain | A 10-line shell script | A Bun program running as root |

`setpriv --bounding-set=-all` fails with "Operation not permitted", because changing the bounding set needs `CAP_SETPCAP`. That flag isn't needed: `cap_drop` already limits the container's bounding set, and switching to a non-root user clears the remaining capabilities.

Isolation, measured with variant A, probing as each user:

| Probe | `aphelion-bot` | `aphelion-plugins` |
| --- | --- | --- |
| List `/etc/aphelion`, `/var/lib/aphelion`, `/var/lib/aphelion-secrets` | Denied | Denied |
| Read the bootstrap secret | Denied | Denied |
| Write the managed settings or `/usr/local/bin` | Denied (`EACCES`, `EROFS`) | Denied |
| Write the bot folders | Allowed | Denied |
| Switch to `harness` | Denied (`EPERM`) | Denied (`EPERM`) |

Not tested: `SO_PEERCRED` checks on the runner sockets that 0016 and 0018 describe. Node's `net` module documents no way to read a Unix socket peer's credentials, and Bun's docs don't either (inferred, not measured). M1-04 must confirm a mechanism before relying on it. The stdin handoff in question 5 is one alternative: the init can give each runner a pipe to the server before dropping privileges.

### 3. Do the dependencies work on Bun

Yes from source. One fails in a compiled binary (measured).

| Dependency | `bun` from source | Compiled binary, `node_modules` hidden |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.32.2, stdio | Pass | Pass |
| `@modelcontextprotocol/sdk` 1.32.2, Streamable HTTP | Pass | Pass |
| `@agentclientprotocol/sdk` 2.9.1 (against `grok agent stdio`) | Pass | Pass |
| `@agentclientprotocol/claude-agent-acp` 0.109.1 | Pass | Not compiled. It runs as its own process. |
| `age-encryption` 0.3.1 | Pass | Pass |
| `@bitwarden/sdk-napi` 1.0.0 | Pass | Pass. The native addon is embedded. |
| `@1password/sdk` 0.5.0 | Pass | **Fail.** `ENOENT` on `.../@1password/sdk-core/nodejs/core_bg.wasm` |

The first compiled run passed every check, but only because `node_modules` was still on disk at the path baked into the binary. Hiding `node_modules` showed that the 1Password SDK reads its WebAssembly core from that path at runtime.

The fix follows from [decision 0018](../decisions/0018-shared-plugin-user.md): the 1Password backend is a plugin, and plugins run as their own processes. The server is a compiled binary, and plugins run from their installed package folders with the `bun` runtime. The image ships `bun`.

### 4. How do Vitest tests reach Bun-only modules

With `bun --bun vitest run` and `pool: "threads"` (measured, Vitest 5.1.1).

| Command | Result |
| --- | --- |
| `bunx vitest run` (Vitest on Node) | Fails: "Cannot find package 'bun:sqlite'" |
| `bun --bun vitest run` (default `forks` pool) | Crashes: "child.channel?.unref is not a function" |
| `bun --bun vitest run --pool=vmThreads` | Fails: "The property 'exportNames.default' is duplicated" |
| `bun --bun vitest run --pool=threads` | Passes |
| `bun test` on the same file | Passes |

### 5. How does the host start Compose and pass the bootstrap secret

- `systemd-analyze verify` passes on a host unit with `Type=exec`, `LoadCredentialEncrypted=bootstrap:...`, an `ExecStartPre` that waits for `tailscale ip -4`, and `docker compose up` in the foreground (measured). In the foreground, the credential directory lives as long as the containers do (inferred).
- `systemd-creds --user encrypt` and `decrypt` round-trip the credential (measured). This VM has no TPM, so on hosts like it the credential is bound to the host key, as the plan allows.
- **Compose ignores `uid`, `gid` and `mode` on file secrets** (measured). The secret appeared inside the container with the host file's owner and mode, so `aphelion-secrets` couldn't read it.
- **The working design** (measured): the secret file is owned by root, mode 0400. The init opens it as root and hands it to the broker on stdin before `setpriv` drops privileges. The broker received all 23 bytes. Inside the container, only uid 0 can read the file; uids 10003 and 10002 are denied. In `sh`, the redirect must sit on the backgrounded command itself, or the shell gives that command `/dev/null`.

Not tested, because it needs root on the host: installing the unit, starting it on boot, and a reboot. The exit test in M0-12 covers them.

## Review findings

After this finding was written, two independent adversarial reviewers (Claude Haiku 5.5 and Grok 4.7 Fast) tried to break the design with real runs, and every finding was rerun before it was kept. File and secret isolation held. These four did not, and [decision 0022](../decisions/0022-bot-network-boundary.md) answers them:

| Finding | Evidence (measured) |
| --- | --- |
| Bots aren't blocked from the LAN | As `aphelion-bot`, one connect each succeeded to `10.0.0.1:80`, `10.0.0.133:22`, `100.71.226.67:22`, `100.93.139.95:22`, `172.17.0.1:22` and `1.1.1.1:443` |
| Every container user reaches the server API on loopback | `127.0.0.1:7400/health` returned `200` to uids 10002 and 10004 |
| The server follows symlinks that bots plant | A bot's `instructions.md` linked to `/etc/aphelion/policy.json`: the bot got `Permission denied`, and the server read the policy. Opening with `O_NOFOLLOW` returned `ELOOP`. |
| Node and Bun can't read socket peer credentials | `net.Socket` on Node 24 and Bun 1.4.5 exposes only `_getpeername` |

## Downstream changes

These apply once decisions 0021 and 0022 are approved.

| Issue | Change |
| --- | --- |
| [M0-04](https://github.com/jcore9/Aphelion/issues/5) | Run tests with `bun --bun vitest run`, with `pool: "threads"` in the Vitest config. |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) | Use `tini` plus a `setpriv --init-groups` launcher. Hand the root-only bootstrap secret to the broker on stdin. Wait for the tailnet address in `ExecStartPre`. Ship the `bun` runtime for plugins. |
| [M0-14c](https://github.com/jcore9/Aphelion/issues/105) | The broker reads the bootstrap secret from stdin, not from a file mounted for its user. |
| [M0-13b](https://github.com/jcore9/Aphelion/issues/100) | Plugins run as `bun <entry>` from their installed package folder. The plugin runner channel uses init-created pipes, not `SO_PEERCRED`. |
| [M1-04](https://github.com/jcore9/Aphelion/issues/22) | Talk to the bot runner over init-created pipes, through one framed message channel. Never signal bot PIDs or read `/proc` directly. Set bot egress only through `HTTPS_PROXY` and `NO_PROXY`. |
| [M0-12](https://github.com/jcore9/Aphelion/issues/14) (network) | Install the `DOCKER-USER` rules for a pinned bridge network. The exit test repeats the six connects and requires the first five to fail. |
| [M0-10b](https://github.com/jcore9/Aphelion/issues/98) | Require a device token on every endpoint except `/health`, including from `127.0.0.1`. |
| [M4-02](https://github.com/jcore9/Aphelion/issues/45) | Read bot files only through the no-follow helper. A lint rule bans other reads under the bots root. |
