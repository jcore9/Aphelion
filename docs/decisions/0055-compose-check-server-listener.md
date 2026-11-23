# 0055. With `--compose`, the config check requires the server to listen on 0.0.0.0 port 7400

- Status: Proposed
- Date: 2026-11-23
- Decided by: project owner
- Proposed by: the orchestrator, in the PR for [#165](https://github.com/jcore9/Aphelion/issues/165) (M0-21)
- Answers: which server address and port `aphelion config check --compose` accepts, and what it does when the server's service publishes no port

## Context

`aphelion config check --compose` reads the output of `docker compose config` and refuses a port published anywhere but the tailnet ([the Compose port rule](../reference/server.md#the-compose-port-rule)). It didn't compare that output with `server.yaml`. A config with `address: 127.0.0.1` and `port: 7401` passed against the shipped Compose file, and the server then couldn't be reached:

- Compose forwards a connection from the host to the container's own network interface. A server that listens on `127.0.0.1` inside the container never sees it.
- The host firewall lets new connections into the container only on port 7400 ([`deploy/host/firewall`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/firewall)). A server on any other port can't be reached, whatever the Compose file forwards.

A test on Docker 29 with Bun 1.4.5, on an IPv4-only bridge network like Aphelion's, showed a server on `127.0.0.1` refuses forwarded connections, and a server on `0.0.0.0` or `::` answers them. `::` works only while the host allows IPv6 in the container.

## Options

### Which address the check accepts

1. **Only `0.0.0.0`.** The shipped value. It works on every host. The container network is IPv4 only, so `::` adds nothing.
2. **`0.0.0.0` or `::`.** Also accepts the IPv6 form, but the server can't start on a host with IPv6 turned off.

### Which port the check accepts

1. **Only 7400.** The firewall opens 7400, so the server must listen there, and every port the `aphelion` service publishes must forward to it. The host side of the mapping can still be any port, such as `"100.71.226.67:8443:7400"`.
2. **A port setting shared by the firewall, the Compose file and the check.** A bigger change outside #165.

### A service that publishes no port

1. **Accept it.** Nothing is mapped, so no mapping is wrong. CI's container test publishes nothing because CI has no tailnet address.
2. **Refuse it.** Nothing outside the container reaches the server, but CI's container test would need another way to run.

## Decision

The owner chose option 1 in all three cases. With `--compose`:

- `server.yaml`'s `address` must be `0.0.0.0`.
- `server.yaml`'s `port` must be 7400.
- Every port the `aphelion` service publishes must forward to the server's port over TCP. The server and the firewall take only TCP, so a UDP mapping is refused too. A service that publishes no port passes.

Each refusal names the setting, the value found and the value expected. Without `--compose`, any valid address and port stay valid, so running from source on `127.0.0.1` still works.

## Consequences

- An operator who wants another port on the tailnet changes the host side of the Compose mapping, not `server.yaml`.
- A test checks that the port in the check matches the port in the firewall script, so the two can't drift apart.
- Revisit if the firewall port becomes a setting, or if the container network gets IPv6.
