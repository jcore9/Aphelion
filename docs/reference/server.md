# The HTTP and WebSocket server

The server answers HTTP requests and WebSocket connections from Aphelion's clients. HTTP is the request-and-reply protocol that web browsers and `curl` use. A WebSocket is a connection that starts as an HTTP request and then stays open, so both sides can send messages at any time. Clients will use one to exchange [protocol frames](protocol.md).

Without a [device token](devices.md), the server answers one question, "are you running?", and refuses everything else. With a valid token, a client can open a WebSocket on `/ws`. [Decision 0043](../decisions/0043-http-server-on-effect-platform-bun.md) explains how the server is built.

## Where it listens

The server listens on the `address` and `port` in [`server.yaml`](config.md#serveryaml-version-1).

| Where Aphelion runs | `address` | Who can connect |
| --- | --- | --- |
| In the container | `0.0.0.0` | Every process in the container, and the host through the port that the Compose file publishes |
| On a developer's machine | `127.0.0.1` | Programs on the same machine only |

`0.0.0.0` means every network interface of the container. The container has its own interfaces, separate from the host's. The host's network is reached only through the published port, so the Compose file decides which host address exposes the server ([decision 0016](../decisions/0016-one-docker-container.md)).

In the container, the address must be `0.0.0.0` and the port must be 7400. Compose forwards connections to the container's own interface, so a server on `127.0.0.1` never sees them. The host firewall lets connections into the container only on port 7400. [`aphelion config check --compose`](cli.md#checking-the-compose-file) refuses any other address or port ([decision 0055](../decisions/0055-compose-check-server-listener.md)).

Every process inside the container can reach the server on `127.0.0.1`, bots included. For that reason, the server trusts no request because of where it comes from ([decision 0022](../decisions/0022-bot-network-boundary.md)).

## What `/health` returns

A `GET` request for exactly `/health` needs no token. The reply is status `200`, with content type `application/json` and exactly this body:

```json
{"status":"ok"}
```

The reply never carries a version or any other detail, so it tells an attacker nothing about the server.

Only the method `GET` with the request target `/health` is public. The request target is the path plus any query string. A request with a query string, such as `/health?verbose=1`, goes through the token check like every other request, so without a token it gets `401`.

One known limit: a request may name the full URL instead of the path, as in `GET http://example.com/health HTTP/1.1`. The listener removes the scheme and host before Aphelion's handler sees the request, so the handler can't tell this request from `GET /health`. It gets the same `200` and the same body, and nothing else. Aphelion accepts this.

```sh
curl http://127.0.0.1:7400/health
```

## What the server answers

Decision 0022 says that every endpoint except `/health` needs a device token, even a request from `127.0.0.1`. The token goes in the `Authorization` header, as `Authorization: Bearer aph_dev_…`. [Device tokens](devices.md) explains how tokens are made, checked and revoked.

| Request | Reply |
| --- | --- |
| `GET /health` | `200` and `{"status":"ok"}`, with or without a token |
| Any other request without a valid token | `401` with an empty body |
| A WebSocket to `GET /ws` with a valid token | The connection switches to a WebSocket. See [WebSockets](#websockets). |
| A WebSocket without a valid token, or to any other path | Refused before the switch. The client sees the connection fail. |
| `GET /ws` with a valid token but no WebSocket request | `400` with an empty body |
| Any other request with a valid token | `404` with an empty body. M1 adds the API. |
| A request body larger than 64 KiB | `413`, from the listener, before the token check runs |
| `CONNECT` | `501` with an empty body, from the listener, before the token check runs. No tunnel opens. |

"A valid token" means a device token that exists, matches, hasn't expired and hasn't been revoked. A missing token and each kind of bad token get exactly the same `401`, with the same headers and an empty body. `401` means "you haven't proved who you are". The reply doesn't say which check failed, or whether the path exists.

Two replies come from the listener, `@effect/platform-bun`, before Aphelion's own code sees the request:

- The listener refuses a request body over 64 KiB (65,536 bytes) with `413`. No endpoint needs a larger body yet, so the limit stays.
- `CONNECT` asks a server to open a tunnel to another host. The listener answers every `CONNECT` with `501` ("not implemented") and an empty body, and opens no tunnel. It is the one refusal that isn't `401`.

## WebSockets

A client with a valid token opens a WebSocket on `/ws` and sends [protocol frames](protocol.md), one JSON text message each. The server reads each one with `parseClientFrame`. M1 answers the frames. Until then the server reads them and sends nothing back.

The server closes the WebSocket in these cases. The close code and reason are fixed text.

| When | Close code | Reason |
| --- | --- | --- |
| A message isn't a valid client frame, or is binary | `1007` | `malformed frame` |
| A frame has a protocol version that the server doesn't speak | `1007` | `unsupported version` |
| The token is revoked or expires | `1008` | `token no longer valid` |
| A message is larger than 64 KiB | `1009` | Set by Bun |
| Unread messages from the client pass 256 KiB | `1008` | `Inbound message buffer limit exceeded`, set by the listener |

The server checks the token again every 5 seconds while the WebSocket is open, so a revoked or expired token closes it within 5 seconds.

These limits are set in [`apps/server/src/adapters/http-server.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/adapters/http-server.ts):

| Limit | Value | Why |
| --- | --- | --- |
| Largest message | 64 KiB | Matches the request body limit. Bun's default is 16 MiB. |
| Unread messages from the client | 256 KiB | Bun can't pause a client, so the listener closes one that sends faster than the server reads. The default is no limit. |
| Unsent messages to the client | 1 MiB, then the WebSocket closes | A client that stops reading can't make the server hold its messages without limit. Bun's default is 16 MiB, and it keeps the connection open. |
| Idle time | 60 seconds | Bun pings the client shortly before, so a client that answers stays connected. Bun's default is 120 seconds. |

Compression stays off, so a small compressed message can't expand into a large one.

## The Compose port rule

The Compose file must publish the server's port only on the host's tailnet address. The tailnet is the private network that Tailscale builds between the owner's devices. Its IPv4 addresses are in the range `100.64.0.0/10`, which runs from `100.64.0.0` to `100.127.255.255`.

`checkComposePorts(file, text, serverPort)` reads the output of `docker compose config`, as YAML or as the JSON that `--format json` prints, and lists every port that breaks the rule. That command prints the Compose model that Docker will run. It fills in variables such as `${TAILNET_IP}`, and merges `include`, `extends` and override files such as `compose.override.yaml` into one file. `aphelion config check --compose -` reads that output from standard input and runs the check on it. It passes `serverPort`, the port from `server.yaml`, so the check also compares each port of the `aphelion` service with it. `checkServerListener` checks the address and port themselves against `composeListener`, `0.0.0.0` port 7400. [The `aphelion` command](cli.md#checking-the-compose-file) shows the command line.

The check looks at every published port of every service, not only the server's port, because nothing else in the container should be published ([decision 0022](../decisions/0022-bot-network-boundary.md)). The owner confirmed this rule on 2026-11-22.

| `ports` entry in the Compose file | Result |
| --- | --- |
| `"100.71.226.67:7400:7400"` | Accepted |
| `{ target: 7400, published: 7400, host_ip: 100.71.226.67 }` | Accepted |
| `"0.0.0.0:7400:7400"` | Refused. `0.0.0.0` is every IPv4 address of the host, the LAN included. |
| `"[::]:7400:7400"` | Refused. `::` is every IPv6 address of the host. |
| `"7400:7400"`, `"7400"` or `7400` | Refused. A port with no host address is published on every host address. |
| `{ target: 7400, published: 7400 }` | Refused, for the same reason |
| `"127.0.0.1:7400:7400"` or `"10.0.0.133:7400:7400"` | Refused. The address is outside the tailnet. |

These are refused too:

- A service with `network_mode: host`. It shares the host's network, so the host publishes every port that the service listens on, on every host address.
- A network whose `name` or `driver` is `host`, for the same reason.
- A service with `network_mode: container:<name>`. It shares the network of a container outside the file, so the check can't see which ports that container publishes.
- A network with any `driver` other than `bridge`, such as `macvlan`, `ipvlan` or `overlay`.
- A bridge network whose `driver_opts` set `com.docker.network.bridge.gateway_mode_ipv4` or `com.docker.network.bridge.gateway_mode_ipv6` to anything but `nat`, the default. In `routed` or `nat-unprotected` mode, Docker lets other machines reach the container's own address directly, whatever host address a port names ([Docker's port publishing guide](https://docs.docker.com/engine/network/port-publishing/)).
- A network with `external: true`. It is defined outside the file, so the check can't see its driver or options.

The check fails closed. It refuses anything that it can't judge, because a value that isn't resolved could hide one of the cases above. For example, `network_mode: ${MODE}` could resolve to `host`. These are refused as "not resolved", with a reminder to run the check on the output of `docker compose config`:

- a `$` in a `ports` entry, in `network_mode`, or in a service's or the file's `networks`;
- `include` or `extends`;
- a Compose YAML tag, such as `!reset` or `!override`.

Each refusal names the file, line, column and entry, then says how to fix it:

```
compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on every host address. Publish it only on the host's tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).
```

### What the check guarantees

When the check passes, every port the file publishes is bound only to a tailnet address, on bridge networks in NAT mode. `aphelion config check --compose` adds a second check, with the `server.yaml` values: every port the `aphelion` service publishes forwards to the server's TCP port, and the server listens on `0.0.0.0` port 7400 ([checking the Compose file](cli.md#checking-the-compose-file)). It says nothing about the host itself. The host firewall from [decision 0022](../decisions/0022-bot-network-boundary.md) is the second layer, and it blocks the container from the LAN whatever the Compose file says.

The check parses the YAML with the `yaml` package and checks its shape with Zod. The server's own validation uses Zod, not Effect's `Schema` module. The owner decided this on 2026-11-22 ([decision 0041](../decisions/0041-effect-in-server-and-cli.md#owner-decision-2026-11-22)).

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/http/app.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/http/app.ts) | The request handler and the `Authenticator` service |
| [`apps/server/src/http/authenticator.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/http/authenticator.ts) | `deviceTokens(db)`, the `Authenticator` that checks device tokens |
| [`apps/server/src/http/socket.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/http/socket.ts) | One WebSocket: reads frames and closes it when a frame is bad or the token ends |
| [`apps/server/src/http/index.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/http/index.ts) | `serveHttp({ address, port }, db)`, which starts the server |
| [`apps/server/src/adapters/http-server.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/adapters/http-server.ts) | The Bun listener and its WebSocket limits, the only file that imports `@effect/platform-bun` |
| [`apps/server/src/config/compose.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/config/compose.ts) | `checkComposePorts`, `checkServerListener` and `composeListener` |
