# 0021. The container's init is tini plus setpriv, and the bootstrap secret arrives on stdin

- Status: Proposed (approved when this PR merges)
- Date: 2026-11-21
- Proposed by: orchestrator, from the [M0-03 finding](../spikes/M0-03-headless-on-bun.md)
- Amended by: [0022](0022-agent-network-boundary.md) (runner channels use init-created pipes, not `SO_PEERCRED`)
- Amends: [0016](0016-one-docker-container.md) (the init tool, and how the bootstrap secret reaches the broker), [0018](0018-shared-plugin-user.md) (how plugins run)

## Context

[Decision 0016](0016-one-docker-container.md) left the init tool to M0-12, and said the bootstrap secret would be "a Compose secret, mounted readable only by `aphelion-secrets`". The M0-03 spike tested both, and found two problems:

- A Bun launcher that uses `spawn({ uid, gid })` starts the children with no supplementary groups. That breaks `harness`'s read access to the agent folders through group `aphelion-agent`.
- Compose ignores `uid`, `gid` and `mode` on file secrets, so it can't make the secret readable by `aphelion-secrets` only.

The spike also found that the 1Password SDK can't run inside a compiled binary, because it reads its WebAssembly core from `node_modules` at runtime.

## Options

For the init:

1. `tini` as PID 1, running a short shell script that starts each process with `setpriv --reuid --regid --init-groups --inh-caps=-all`.
2. A compiled Bun launcher as root, using `spawn({ uid, gid })`. It would need extra code to set supplementary groups.
3. s6-overlay. Not tested, and it brings more moving parts than four processes need.

For the bootstrap secret:

1. Keep the secret file owned by root, mode 0400. The init opens it and hands it to the broker on stdin before dropping privileges.
2. Have the host create the file owned by uid 10003. That puts container user IDs into host setup, and the file then stays readable by that uid for as long as it's mounted.

## Decision

Option 1 for both.

- **Init.** `tini` runs a launcher script. The script starts the server, the broker, the agent runner and the plugin runner, each with `setpriv --init-groups --inh-caps=-all`. It doesn't use `--bounding-set`, which needs `CAP_SETPCAP`; the container's `cap_drop` already limits the bounding set. No root-owned program of our own runs in the container.
- **Bootstrap secret.** On the host, the file in `$CREDENTIALS_DIRECTORY` is owned by root. Compose mounts it at `/run/secrets/bootstrap`. The launcher opens it as root and passes it to the broker as stdin, then drops privileges. No container user other than root can read the file.
- **Plugins.** The server and the CLI are one compiled binary. Plugins run from their installed package folders with the `bun` runtime, which the image includes. That keeps SDKs such as 1Password's, which load files at runtime, working, and it matches how plugins install from npm, git or a local folder.

## Consequences

- The host unit waits for the tailnet address before starting Compose, because Docker refuses to publish a port on an address that doesn't exist yet.
- The image is larger by the `bun` runtime.
- The `SO_PEERCRED` checks on the runner sockets in 0016 and 0018 are unconfirmed in Node and Bun. M1-04 and M0-13b must confirm a mechanism, or use pipes that the launcher sets up before dropping privileges, the same way it hands over the secret.
- M0-04, M0-12, M0-13b, M0-14c and M1-04 change as listed in the finding.
