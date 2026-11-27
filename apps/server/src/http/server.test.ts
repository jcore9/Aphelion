import { encodeFrame } from "@aphelion/protocol";
import { expect, layer } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Exit, Scope } from "effect";
import { HttpServer } from "effect/http";
import { afterAll } from "vitest";
import { webSocketLimits } from "../adapters/http-server";
import { addDevice, revokeDevice } from "../devices";
import { finishRestore } from "../restore";
import { openEventStore } from "../history";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { serveHttp } from "./index";
import { idleCommands } from "./test-client";

const live = { excludeTestServices: true };
const day = 24 * 60 * 60 * 1000;

const dir = mkdtempSync(join(tmpdir(), "aphelion-http-"));
const db = openStore(join(dir, "aphelion.db"));
const historyScope = Effect.runSync(Scope.make());
const history = Effect.runSync(
  openEventStore(db, readServerId(db), {
    logger: createLogger({ write: () => undefined }),
  }).pipe(Scope.provide(historyScope)),
);
afterAll(() => {
  Effect.runSync(Scope.close(historyScope, Exit.void));
  db.close();
  rmSync(dir, { recursive: true });
});

const valid = addDevice(db, { name: "laptop" }).token;
const revoked = addDevice(db, { name: "old phone" });
revokeDevice(db, revoked.id);
const expired = addDevice(
  db,
  { name: "tablet", lifetimeDays: 1 },
  new Date(Date.now() - 2 * day),
).token;
const wrongSecret = `${valid.slice(0, -4)}${valid.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
const unknownDevice = `aph_dev_0123456789abcdef${valid.slice(-44)}`;

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const refused: Record<string, Record<string, string>> = {
  "no token": {},
  "an empty header": { authorization: "" },
  "a header that isn't Bearer": { authorization: `Basic ${valid}` },
  "a token that isn't a device token": bearer("any-token"),
  "a wrong secret": bearer(wrongSecret),
  "an unknown device": bearer(unknownDevice),
  "an expired token": bearer(expired),
  "a revoked token": bearer(revoked.token),
};

const baseUrl = HttpServer.addressFormattedWith(Effect.succeed);

const request = (path: string, init?: RequestInit) =>
  Effect.flatMap(baseUrl, (url) =>
    Effect.promise(async () => {
      const response = await fetch(`${url}${path}`, init);
      const headers = [...response.headers].filter(([name]) => name !== "date");
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        headers,
        body: await response.text(),
      };
    }),
  );

interface Closed {
  readonly code: number;
  readonly reason: string;
}

interface Live {
  readonly socket: WebSocket;
  readonly closed: Promise<Closed>;
}

const openWebSocket = (path: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(baseUrl, (url) =>
    Effect.promise(
      () =>
        new Promise<Live | "refused">((resolve) => {
          const socket = new WebSocket(`${url.replace(/^http/, "ws")}${path}`, {
            headers,
          });
          const closed = new Promise<Closed>((done) => {
            socket.addEventListener("close", ({ code, reason }) => {
              done({ code, reason });
              resolve("refused");
            });
          });
          socket.addEventListener("open", () => {
            resolve({ socket, closed });
          });
        }),
    ),
  );

const openLive = (headers: Record<string, string>) =>
  Effect.flatMap(openWebSocket("/ws", headers), (opened) =>
    opened === "refused"
      ? Effect.die("the socket was refused")
      : Effect.succeed(opened),
  );

const closedBy = (live: Live) => Effect.promise(() => live.closed);

const stillOpenAfter = (live: Live, ms: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(live.socket.readyState === WebSocket.OPEN);
        }, ms);
      }),
  );

const rawRequest = (head: string) =>
  Effect.flatMap(baseUrl, (url) =>
    Effect.promise(
      () =>
        new Promise<string>((resolve) => {
          const { hostname, port } = new URL(url);
          const socket = connect(Number(port), hostname, () => {
            socket.end(head);
          });
          let reply = "";
          socket.on("data", (chunk) => {
            reply += chunk.toString();
          });
          socket.on("close", () => {
            resolve(reply);
          });
        }),
    ),
  );

const paths = [
  "/",
  "/ws",
  "/api/status",
  "/health/",
  "/healthz",
  "/HEALTH",
  "/health?",
  "/health?verbose=1",
];

const resume = encodeFrame({ v: 1, type: "resume", cursor: null });

layer(
  serveHttp({ address: "127.0.0.1", port: 0 }, db, history, idleCommands, {
    recheckEvery: Duration.millis(20),
  }),
  live,
)("the server with device tokens", (it) => {
  it.effect("listens on the configured address", () =>
    Effect.gen(function* () {
      expect(yield* baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    }),
  );

  it.effect('answers /health with exactly {"status":"ok"} and no token', () =>
    Effect.gen(function* () {
      expect(yield* request("/health")).toMatchObject({
        status: 200,
        type: "application/json",
        body: '{"status":"ok"}',
      });
    }),
  );

  it.effect("accepts a valid token: no route matches yet, so 404", () =>
    Effect.gen(function* () {
      for (const path of paths.filter((p) => p !== "/ws")) {
        expect(yield* request(path, { headers: bearer(valid) })).toMatchObject({
          status: 404,
          body: "",
        });
      }
      expect(yield* request("/ws", { headers: bearer(valid) })).toMatchObject({
        status: 400,
        body: "",
      });
    }),
  );

  it.effect("gives every refused token the same empty 401, on every path", () =>
    Effect.gen(function* () {
      const baseline = yield* request("/api/status");
      expect(baseline).toMatchObject({ status: 401, body: "" });
      for (const path of paths) {
        for (const [name, headers] of Object.entries(refused)) {
          expect(yield* request(path, { headers }), `${path}, ${name}`).toEqual(
            baseline,
          );
        }
      }
      expect(yield* request("/health", { method: "POST", body: "{}" })).toEqual(
        baseline,
      );
      expect(yield* request(`/api/status?token=${valid}`)).toEqual(baseline);
    }),
  );

  it.effect("refuses a request body over 64 KiB with 413", () =>
    Effect.gen(function* () {
      const limit = 64 * 1024;
      const post = (size: number) =>
        request("/api", {
          method: "POST",
          headers: bearer(valid),
          body: "x".repeat(size),
        });
      expect((yield* post(limit)).status).toBe(404);
      expect((yield* post(limit + 1)).status).toBe(413);
    }),
  );

  it.effect("answers CONNECT with an empty 501 and opens no tunnel", () =>
    Effect.gen(function* () {
      const reply = yield* rawRequest(
        "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
      );
      const [head = "", body] = reply.split("\r\n\r\n");
      expect(head.split("\r\n")[0]).toBe("HTTP/1.1 501 Not Implemented");
      expect(head).toMatch(/\r\ncontent-length: 0(\r\n|$)/i);
      expect(body).toBe("");
    }),
  );

  it.effect("never upgrades a WebSocket without a valid token", () =>
    Effect.gen(function* () {
      for (const headers of Object.values(refused)) {
        expect(yield* openWebSocket("/ws", headers)).toBe("refused");
      }
      const reply = yield* rawRequest(
        [
          "GET /ws HTTP/1.1",
          "Host: localhost",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
      expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
    }),
  );

  it.effect("opens a WebSocket with a valid token on /ws only", () =>
    Effect.gen(function* () {
      for (const path of ["/health", ...paths.filter((p) => p !== "/ws")]) {
        expect(yield* openWebSocket(path, bearer(valid))).toBe("refused");
      }
      const socket = yield* openLive(bearer(valid));
      socket.socket.send(resume);
      expect(yield* stillOpenAfter(socket, 100)).toBe(true);
      socket.socket.close();
    }),
  );

  it.effect("closes a WebSocket that sends a frame it can't parse", () =>
    Effect.gen(function* () {
      const cases = [
        ["not JSON", "{", { code: 1007, reason: "malformed frame" }],
        [
          "an unknown frame",
          '{"v":1,"type":"hello"}',
          { code: 1007, reason: "malformed frame" },
        ],
        [
          "a binary message",
          new Uint8Array([1, 2, 3]),
          { code: 1007, reason: "malformed frame" },
        ],
        [
          "another protocol version",
          '{"v":2,"type":"resume","cursor":null}',
          { code: 1007, reason: "unsupported version" },
        ],
      ] as const;
      for (const [name, message, expected] of cases) {
        const socket = yield* openLive(bearer(valid));
        socket.socket.send(resume);
        socket.socket.send(message);
        expect(yield* closedBy(socket), name).toEqual(expected);
      }
    }),
  );

  it.effect("closes a WebSocket whose message is over the limit", () =>
    Effect.gen(function* () {
      const socket = yield* openLive(bearer(valid));
      socket.socket.send("x".repeat(webSocketLimits.maxPayloadLength + 1));
      expect((yield* closedBy(socket)).code).toBe(1009);
    }),
  );

  it.effect("closes a live WebSocket when its token is revoked", () =>
    Effect.gen(function* () {
      const phone = addDevice(db, { name: "phone" });
      const socket = yield* openLive(bearer(phone.token));
      expect(yield* stillOpenAfter(socket, 100)).toBe(true);
      revokeDevice(db, phone.id);
      expect(yield* closedBy(socket)).toEqual({
        code: 1008,
        reason: "token no longer valid",
      });
    }),
  );

  it.effect("closes a live WebSocket when its token expires", () =>
    Effect.gen(function* () {
      const soon = addDevice(
        db,
        { name: "watch", lifetimeDays: 1 },
        new Date(Date.now() - day + 300),
      );
      const socket = yield* openLive(bearer(soon.token));
      expect(yield* closedBy(socket)).toEqual({
        code: 1008,
        reason: "token no longer valid",
      });
    }),
  );
});

layer(
  serveHttp({ address: "127.0.0.1", port: 0 }, db, history, idleCommands, {
    recheckEvery: Duration.millis(20),
  }),
  live,
)("the server after a restore", (it) => {
  it.effect(
    "refuses every token from before the restore, over HTTP and WebSocket, until a device is enrolled",
    () =>
      Effect.gen(function* () {
        const phone = addDevice(db, { name: "phone" });
        const socket = yield* openLive(bearer(phone.token));
        expect(yield* stillOpenAfter(socket, 100)).toBe(true);

        finishRestore(db);

        expect(yield* closedBy(socket)).toEqual({
          code: 1008,
          reason: "token no longer valid",
        });
        for (const token of [valid, phone.token]) {
          for (const path of paths.filter((p) => p !== "/ws")) {
            expect(
              yield* request(path, { headers: bearer(token) }),
            ).toMatchObject({ status: 401, body: "" });
          }
          expect(yield* openWebSocket("/ws", bearer(token))).toBe("refused");
        }
        expect(yield* request("/health")).toMatchObject({ status: 200 });

        const fresh = addDevice(
          db,
          { name: "phone" },
          new Date(Date.now() + 5000),
        );
        expect(
          yield* request("/api/status", { headers: bearer(fresh.token) }),
        ).toMatchObject({ status: 404 });
      }),
  );
});
