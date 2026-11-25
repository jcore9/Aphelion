# M0-10b finding: Tailscale `whois` from inside the container

- Issue: [M0-10b](https://github.com/jcore9/Aphelion/issues/98)
- Date: 2026-11-22. Every source below was read on this date.
- Method: reading Tailscale's documentation and source code. Nothing ran against a real tailnet, because the tests have none. Each claim is labelled **sourced** (a quote from the linked page) or **inferred** (reasoning from sourced facts).
- Decision: [0013](../decisions/0013-tailscale-identity.md) asks this question. The answer is no, so M0 ships device tokens only, and [#142](https://github.com/jcore9/Aphelion/issues/142) carries the identity check into M5.

## The question

Can Aphelion's server, running inside the container, learn which tailnet device sent a request, without Tailscale operator rights and without the host's Tailscale socket?

Terms used on this page:

- **tailscaled.** The Tailscale program that runs on the host and joins it to the tailnet.
- **LocalAPI.** The HTTP interface that tailscaled offers on a Unix socket, `/var/run/tailscale/tailscaled.sock` on Linux. The `tailscale` command talks to it.
- **Operator.** A Unix user, other than root, that the owner names with `tailscale set --operator`. The operator may change tailscaled's settings.

## Answer

**No.** `whois` needs no operator rights, but it does need the LocalAPI socket, and the container doesn't have it.

1. **`whois` asks tailscaled.** `tailscale whois ip[:port]` gets "the machine and user associated with a Tailscale IP" ([CLI reference](https://tailscale.com/kb/1080/cli)). The command sends the question to the LocalAPI. **Sourced.**
2. **It needs read access only.** The LocalAPI's `whois` handler refuses a caller without read permission: `if !h.PermitRead {` … `"whois access denied"` ([`ipn/localapi/localapi.go`](https://github.com/tailscale/tailscale/blob/main/ipn/localapi/localapi.go)). **Sourced.**
3. **Any local user gets read access.** For a Unix socket connection, tailscaled returns `true, !a.ci.IsReadonlyConn(...)`: read is always granted, and write only to root, tailscaled's own user, or the operator ([`ipn/ipnserver/server.go`](https://github.com/tailscale/tailscale/blob/main/ipn/ipnserver/server.go), [`ipn/ipnauth/ipnauth.go`](https://github.com/tailscale/tailscale/blob/main/ipn/ipnauth/ipnauth.go)). On Linux the socket's mode is `0666`, so every user can open it ([`safesocket/unixsocket.go`](https://github.com/tailscale/tailscale/blob/main/safesocket/unixsocket.go), [`safesocket/safesocket.go`](https://github.com/tailscale/tailscale/blob/main/safesocket/safesocket.go)). **Sourced.** So operator rights are not the obstacle.
4. **The container has no socket.** tailscaled runs on the host. Its socket is a file on the host, and the container sees it only if the Compose file mounts it. Aphelion's Compose file mounts no host socket ([decision 0016](../decisions/0016-one-docker-container.md)). On Linux, the LocalAPI is that Unix socket and nothing else, so nothing in the container can reach it. **Inferred** from the default socket path in [`paths/paths.go`](https://github.com/tailscale/tailscale/blob/main/paths/paths.go) and the socket code above.
5. **The caller's address alone isn't an identity.** With Docker's default NAT rules, a request that arrives on the published port keeps its source address, a tailnet address such as `100.93.139.95`. **Inferred**: Docker's [port publishing guide](https://docs.docker.com/engine/network/port-publishing/) describes NAT rules for published ports and doesn't state this. Even so, the server would need tailscaled, or Tailscale's web API with an API key, to turn that address into a device name.

## Why not mount the socket

Mounting `tailscaled.sock` into the container would make `whois` work. It would also give every process in the container read access to the LocalAPI, because the socket's mode is `0666`. Bots run in the same container ([decision 0022](../decisions/0022-bot-network-boundary.md)). Read access shows the tailnet's devices, their addresses and their owners. A prompt-injected bot should not see that. So this PR doesn't do it.

## What M0 ships instead

- A per-device token on every endpoint except `GET /health` ([devices reference](../reference/devices.md)).
- The published port bound only to the host's tailnet address ([server reference](../reference/server.md#the-compose-port-rule)).

This is the minimum that decision 0013 sets.

## Options for M5

[#142](https://github.com/jcore9/Aphelion/issues/142) weighs these. None is chosen here.

| Option | What it needs |
| --- | --- |
| A small host program that answers `whois` for the server, over a pipe that the init hands over ([decision 0021](../decisions/0021-container-init-and-secret-handoff.md)) | A program outside the container. The server sends only an address and gets back a device name. |
| Mount the socket inside a folder that only the server's user can enter | Bots can't reach it. The server can read all of the LocalAPI, not only `whois`. |
| Tailscale's web API with an API key | A secret in the broker, and network access to Tailscale's servers |
| Run the server as its own tailnet device with `tsnet` | The server joins the tailnet itself. A large change to how Aphelion is deployed. |
