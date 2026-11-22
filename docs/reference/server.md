# The HTTP and WebSocket server

The server answers HTTP requests and WebSocket connections from Aphelion's clients. HTTP is the request-and-reply protocol that web browsers and `curl` use. A WebSocket is a connection that starts as an HTTP request and then stays open, so both sides can send messages at any time. Clients will use one to exchange [protocol frames](protocol.md).

Until device tokens arrive in M0-10b ([#98](https://github.com/jcore9/Aphelion/issues/98)), the server answers one question, "are you running?", and refuses everything else. [Decision 0043](../decisions/0043-http-server-on-effect-platform-bun.md) explains how it is built.

## Where it listens

The server listens on the `address` and `port` in [`server.yaml`](config.md#serveryaml-version-1).

| Where Aphelion runs | `address` | Who can connect |
| --- | --- | --- |
| In the container | `0.0.0.0` | Every process in the container, and the host through the port that the Compose file publishes |
| On a developer's machine | `127.0.0.1` | Programs on the same machine only |

`0.0.0.0` means every network interface of the container. The container has its own interfaces, separate from the host's. The host's network is reached only through the published port, so the Compose file decides which host address exposes the server ([decision 0016](../decisions/0016-one-docker-container.md)).

Every process inside the container can reach the server on `127.0.0.1`, agents included. For that reason, the server trusts no request because of where it comes from ([decision 0022](../decisions/0022-agent-network-boundary.md)).

## What `/health` returns

A `GET` request to `/health` needs no token. The reply is status `200`, with content type `application/json` and exactly this body:

```json
{"status":"ok"}
```

The reply never carries a version or any other detail, so it tells an attacker nothing about the server. A query string doesn't change the reply, so `/health?verbose=1` returns the same body.

```sh
curl http://127.0.0.1:7400/health
```

## What the server refuses until M0-10b

Decision 0022 says that every endpoint except `/health` needs a device token, even a request from `127.0.0.1`. The server can't check tokens yet, so it refuses every other request.

| Request | Reply |
| --- | --- |
| `GET /health` | `200` and `{"status":"ok"}` |
| Any other path or method, such as `GET /`, `GET /ws` or `POST /health` | `401` with an empty body |
| Any request with an `Authorization` header | `401` with an empty body, because no token is valid yet |
| A WebSocket connection to any path, `/health` included | Refused. The server never switches the connection to a WebSocket, so the client sees the connection fail. |

`401` means "you haven't proved who you are". The reply has no body, so it doesn't say whether the path exists.

In code, each request that isn't `GET /health` goes through one authentication check. Today that check refuses everyone. M0-10b replaces the check with one that reads the device token, and adds the WebSocket route behind it. The WebSocket route will read each frame with `parseClientFrame` from [the protocol package](protocol.md).

## The Compose port rule

The Compose file must publish the server's port only on the host's tailnet address. The tailnet is the private network that Tailscale builds between the owner's devices. Its IPv4 addresses are in the range `100.64.0.0/10`, which runs from `100.64.0.0` to `100.127.255.255`.

`checkComposePorts(file, text)` reads a Compose file and lists every port that breaks the rule. `aphelion config check` will call it (M0-11). The check looks at every port of every service, not only the server's port, because nothing else in the container should be published ([decision 0022](../decisions/0022-agent-network-boundary.md)).

| `ports` entry in the Compose file | Result |
| --- | --- |
| `"100.71.226.67:7400:7400"` | Accepted |
| `{ target: 7400, published: 7400, host_ip: 100.71.226.67 }` | Accepted |
| `"0.0.0.0:7400:7400"` | Refused. `0.0.0.0` is every IPv4 address of the host, the LAN included. |
| `"[::]:7400:7400"` | Refused. `::` is every IPv6 address of the host. |
| `"7400:7400"`, `"7400"` or `7400` | Refused. A port with no host address is published on every host address. |
| `{ target: 7400, published: 7400 }` | Refused, for the same reason |
| `"127.0.0.1:7400:7400"` or `"10.0.0.133:7400:7400"` | Refused. The address is outside the tailnet. |
| `"${TAILNET_IP}:7400:7400"` | Refused. The check reads the file as written and doesn't fill in variables. |

A service with `network_mode: host` is refused too. It shares the host's network, so the host publishes every port that the service listens on, on every host address.

Each refusal names the file, line, column and entry, then says how to fix it:

```
compose.yaml:5:9: services.aphelion.ports[0]: publishes the port on every host address. Publish it only on the host's tailnet address, such as "100.71.226.67:7400:7400" (decision 0022).
```

The check reads one Compose file. It doesn't read override files such as `compose.override.yaml`, `include` or `extends`.

## Code

| File | Holds |
| --- | --- |
| [`packages/server/src/http/app.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/http/app.ts) | The request handler, the `Authenticator` service and `refuseEveryone` |
| [`packages/server/src/http/index.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/http/index.ts) | `serveHttp({ address, port })`, which starts the server with `refuseEveryone` |
| [`packages/server/src/adapters/http-server.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/adapters/http-server.ts) | The Bun listener, the only file that imports `@effect/platform-bun` |
| [`packages/server/src/config/compose.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/config/compose.ts) | `checkComposePorts` |
