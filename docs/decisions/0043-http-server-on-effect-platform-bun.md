# 0043. The server listens through `@effect/platform-bun`'s HTTP server, in an adapter

- Status: Proposed
- Date: 2026-11-22
- Proposed by: the M0-10a PR ([#97](https://github.com/jcore9/Aphelion/issues/97))
- Answers: [decision 0041](0041-effect-in-server-and-cli.md) names `@effect/platform-bun`'s HTTP server as a candidate for M0-10a, and leaves the choice to that PR

## Context

M0-10a builds the server's HTTP and WebSocket listener. [Decision 0041](0041-effect-in-server-and-cli.md) says the server uses Effect, and that Bun-only code, `@effect/platform-bun` included, stays in `packages/server/src/adapters/`. The plan wants the HTTP server behind an interface, so it can be swapped ([decision 0007](0007-bun-runtime.md)).

M0-10b ([#98](https://github.com/jcore9/Aphelion/issues/98)) comes next. It checks a device token on every request except `/health`, and then accepts WebSockets that carry [protocol frames](../reference/protocol.md). The listener has to make both steps easy.

Terms used on this page:

- **Handler.** The code that turns one request into one reply.
- **Upgrade.** A WebSocket starts as an HTTP request that asks to switch protocols. The server upgrades the connection only if the handler says so. A reply without the upgrade refuses the WebSocket.
- **Service and Layer.** Decision 0041 explains both. In short, a service is a named capability that code asks for, and a Layer builds it.

## Options

| | `@effect/platform-bun`'s HTTP server | `Bun.serve` wrapped by hand | A web framework, such as Hono |
| --- | --- | --- | --- |
| The handler | An Effect that reads the request from a service and returns a reply. It doesn't mention Bun. | A plain function from a web `Request` to a `Response`. Running Effect code inside it needs a hand-made bridge. | The framework's own style, beside Effect |
| Start and stop | A Layer. Stopping waits up to 20 seconds for requests in flight, then cancels them. | Hand-written with `Effect.acquireRelease` | Hand-written |
| WebSockets, for M0-10b | `request.upgrade` returns an Effect socket, with a reader and a writer. A limit on unread messages is built in. | Bun's callbacks, one set for the whole server. Bridging them to Effect is about 100 lines, which the first option already has. | The framework's helper, beside Effect |
| Tests | A real listener on port 0, in a Layer that `@effect/vitest` builds and stops | The same, by hand | The same, by hand |
| Cost | The `effect/http` and `@effect/platform-bun` HTTP modules are marked unstable, so their API may change in a minor release. About 3 MB in `node_modules`. | More of our own code to maintain | A third style in the server, and another dependency |

What was measured, with Bun 1.4.5 and `effect`, `@effect/platform-bun` and `@effect/vitest` 4.1.5, on 2026-11-22:

- The M0-10a server, started from the example `server.yaml`, answered `curl` on `127.0.0.1:7400`. `/health` returned `200` and `{"status":"ok"}`. `/api` and `/ws` returned `401` with an empty body. A WebSocket to `/ws` failed with "Expected 101 status code: 401". The host's LAN address got no connection, because the server listened on `127.0.0.1` only.
- A probe that upgraded a WebSocket through `@effect/platform-bun` echoed a message back to the client. The probe lived outside the repo and was deleted. M0-10b can rely on the upgrade.
- The eight tests in `packages/server/src/http/server.test.ts` start the real listener twice and finish in about 0.3 seconds.
- Decision 0041 measured the size. The HTTP server adds about 0.35 MB to the compiled binary.

## Decision

Use `@effect/platform-bun`'s HTTP server, behind an adapter.

- `packages/server/src/adapters/http-server.ts` is the only file that imports `@effect/platform-bun`. It turns `server.yaml`'s `address` and `port` into the listener's Layer. A different listener would replace this one file.
- The handler in `packages/server/src/http/app.ts` uses only plain `effect` modules. It answers a `GET` for exactly `/health` itself, with no query string, and passes every other request to one `Authenticator` service. M0-10a provides `refuseEveryone`, which refuses every request with `401`. M0-10b provides the device-token check in its place, and adds the WebSocket route behind it.
- The listener refuses a request body over 64 KiB with `413`. Bun's default is 128 MiB, far more than a server that only answers `/health` needs. M0-10b raises the limit if the API needs more.
- The listener answers `CONNECT`, a request to open a tunnel to another host, with an empty `501` before the handler runs. Aphelion doesn't override this. It is the one refusal that isn't `401`, and it opens no tunnel. A test checks both.
- The listener closes a connection after 10 seconds with no traffic. The library default is no limit at all, and its documentation warns against that for a server that clients reach directly. Ten seconds is Bun's own default.
- No request is logged. The listener's own "Listening on" log line is not turned on.

## Consequences

- M0-10b plugs a token check into the `Authenticator` service. The handler and the listener don't change. Its WebSocket route must set `maxPayloadLength` and `highWaterMark` on the listener, because the library's defaults are 16 MiB per message and no limit on unread messages.
- M0-11 starts the server with `serveHttp(config.server)` from `@aphelion/server/http`, inside its own Effect program.
- An Effect upgrade can change these modules' API, because they are marked unstable. Decision 0041 already requires every `effect` and `@effect/*` version to change together in one PR. That PR runs the HTTP tests.
- Revisit this record if the unstable HTTP modules change their API in a way that costs more than the adapter, or if the server moves off Bun.
