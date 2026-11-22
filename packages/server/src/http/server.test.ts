import { expect, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { bunHttpServer } from "../adapters/http-server";
import { app, Authenticator } from "./app";
import { serveHttp } from "./index";

const live = { excludeTestServices: true };

const baseUrl = HttpServer.addressFormattedWith(Effect.succeed);

const request = (path: string, init?: RequestInit) =>
  Effect.flatMap(baseUrl, (url) =>
    Effect.promise(async () => {
      const response = await fetch(`${url}${path}`, init);
      return {
        status: response.status,
        type: response.headers.get("content-type"),
        body: await response.text(),
      };
    }),
  );

const openWebSocket = (path: string) =>
  Effect.flatMap(baseUrl, (url) =>
    Effect.promise(
      () =>
        new Promise<"opened" | "refused">((resolve) => {
          const socket = new WebSocket(`${url.replace(/^http/, "ws")}${path}`);
          socket.onopen = () => {
            socket.close();
            resolve("opened");
          };
          socket.onclose = () => {
            resolve("refused");
          };
        }),
    ),
  );

const paths = ["/", "/ws", "/api/status", "/health/", "/healthz", "/HEALTH"];

layer(serveHttp({ address: "127.0.0.1", port: 0 }), live)(
  "the server as M0-10a ships it",
  (it) => {
    it.effect("listens on the configured address", () =>
      Effect.gen(function* () {
        expect(yield* baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      }),
    );

    it.effect('answers /health with exactly {"status":"ok"} and no token', () =>
      Effect.gen(function* () {
        expect(yield* request("/health")).toEqual({
          status: 200,
          type: "application/json",
          body: '{"status":"ok"}',
        });
        expect((yield* request("/health?verbose=1")).body).toBe(
          '{"status":"ok"}',
        );
      }),
    );

    it.effect("refuses every other path with an empty 401", () =>
      Effect.gen(function* () {
        for (const path of paths) {
          expect(yield* request(path)).toMatchObject({ status: 401, body: "" });
          expect(
            yield* request(path, {
              headers: { authorization: "Bearer any-token" },
            }),
          ).toMatchObject({ status: 401, body: "" });
        }
        expect(
          yield* request("/health", { method: "POST", body: "{}" }),
        ).toMatchObject({ status: 401, body: "" });
      }),
    );

    it.effect("refuses every WebSocket, /health included", () =>
      Effect.gen(function* () {
        for (const path of ["/health", ...paths]) {
          expect(yield* openWebSocket(path)).toBe("refused");
        }
      }),
    );
  },
);

const admitEveryone = Layer.succeed(Authenticator, {
  authenticate: () => Effect.void,
});

layer(
  HttpServer.serve(app).pipe(
    Layer.provide(admitEveryone),
    Layer.provideMerge(bunHttpServer({ address: "127.0.0.1", port: 0 })),
  ),
  live,
)("the server once an authenticator admits a request", (it) => {
  it.effect("serves nothing yet: every path is an empty 404", () =>
    Effect.gen(function* () {
      for (const path of paths) {
        expect(yield* request(path)).toMatchObject({ status: 404, body: "" });
      }
      expect((yield* request("/health")).status).toBe(200);
    }),
  );

  it.effect("still opens no WebSocket", () =>
    Effect.gen(function* () {
      expect(yield* openWebSocket("/ws")).toBe("refused");
    }),
  );
});
