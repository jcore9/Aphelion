import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, streamId, type ServerFrame } from "@aphelion/protocol";
import { expect, layer } from "@effect/vitest";
import { Duration, Effect, Exit, Scope } from "effect";
import { HttpServer } from "effect/http";
import { afterAll } from "vitest";
import { addDevice } from "../devices";
import { openEventStore, type EventStore } from "../history";
import { createLogger } from "../log";
import { openStore, readServerId, readStreamId } from "../store";
import { serveHttp } from "./index";
import { connectClient, idleCommands } from "./test-client";

const live = { excludeTestServices: true };

const dir = mkdtempSync(join(tmpdir(), "aphelion-history-http-"));
const path = join(dir, "aphelion.db");
const db = openStore(path);
const token = addDevice(db, { name: "laptop" }).token;
const logger = createLogger({ write: () => undefined });

const scope = Effect.runSync(Scope.make());
const open = (database: typeof db) =>
  Effect.runSync(
    openEventStore(database, readServerId(database), { logger }).pipe(
      Effect.tap((opened) => opened.openTurn("chief", "t1")),
      Scope.provide(scope),
    ),
  );
const store = open(db);
const reopened = openStore(path);
const restarted = open(reopened);
const damaged = openStore(join(dir, "damaged.db"));
const damagedToken = addDevice(damaged, { name: "phone" }).token;
const damagedStore = open(damaged);

afterAll(() => {
  Effect.runSync(Scope.close(scope, Exit.void));
  damaged.close();
  reopened.close();
  db.close();
  rmSync(dir, { recursive: true });
});

const say = (target: EventStore, text: string) =>
  Effect.andThen(
    target.record({
      bot: "chief",
      run: 1,
      turn: "t1",
      event: { type: "text.delta", text },
    }),
    target.flush,
  );

const baseUrl = HttpServer.addressFormattedWith(Effect.succeed);

const connectWith = (bearer: string) =>
  Effect.flatMap(baseUrl, (url) => connectClient(url, bearer));

const connect = connectWith(token);

const seqs = (frames: readonly ServerFrame[]) =>
  frames.map((frame) => (frame.type === "event" ? frame.seq : frame.type));

const cursor = (seq: number, stream = readStreamId(db)) => ({
  stream: streamId.parse(stream),
  seq,
});

layer(
  serveHttp({ address: "127.0.0.1", port: 0 }, db, store, idleCommands, {
    recheckEvery: Duration.seconds(30),
  }),
  live,
)("a client that reconnects", (it) => {
  it.effect(
    "gets the events it missed while it was away, then the live ones",
    () =>
      Effect.gen(function* () {
        const first = yield* connect;
        first.send({ v: 1, type: "resume", cursor: null });
        const [resync] = yield* first.until(1);
        expect(resync).toEqual({
          v: 1,
          type: "resync",
          cursor: cursor(0),
        });

        first.send({ v: 1, type: "resume", cursor: cursor(0) });
        yield* say(store, "one");
        yield* say(store, "two");
        expect(seqs(yield* first.until(3))).toEqual(["resync", 1, 2]);
        first.close();

        yield* say(store, "three");
        yield* say(store, "four");

        const second = yield* connect;
        second.send({ v: 1, type: "resume", cursor: cursor(2) });
        expect(seqs(yield* second.until(2))).toEqual([3, 4]);
        yield* say(store, "five");
        const frames = yield* second.until(3);
        expect(seqs(frames)).toEqual([3, 4, 5]);
        expect(frames[2]).toMatchObject({
          name: "bot.event",
          payload: {
            bot: "chief",
            turn: "t1",
            format: 1,
            event: { type: "text.delta", text: "five" },
          },
        });
        second.close();
      }),
  );

  it.effect("gets one resync for a cursor from another server", () =>
    Effect.gen(function* () {
      const client = yield* connect;
      client.send({
        v: 1,
        type: "resume",
        cursor: cursor(1, "another-server"),
      });

      const [frame] = yield* client.until(1);

      expect(frame).toEqual({
        v: 1,
        type: "resync",
        cursor: cursor(store.head()),
      });
      client.close();
    }),
  );

  it.effect("can resume again on the same connection with a new cursor", () =>
    Effect.gen(function* () {
      const client = yield* connect;
      client.send({ v: 1, type: "resume", cursor: cursor(0) });
      yield* client.until(store.head());
      client.send({ v: 1, type: "resume", cursor: cursor(store.head() - 1) });

      const frames = yield* client.until(store.head() + 1);

      expect(seqs(frames).slice(-1)).toEqual([store.head()]);
      client.close();
    }),
  );
});

layer(
  serveHttp(
    { address: "127.0.0.1", port: 0 },
    reopened,
    restarted,
    idleCommands,
    {
      recheckEvery: Duration.seconds(30),
    },
  ),
  live,
)("a client that reconnects after the server restarted", (it) => {
  it.effect("continues from its cursor in the same stream", () =>
    Effect.gen(function* () {
      const before = store.head();
      expect(restarted.streamId).toBe(store.streamId);
      yield* say(restarted, "after the restart");

      const client = yield* connect;
      client.send({ v: 1, type: "resume", cursor: cursor(before - 1) });
      const frames = yield* client.until(2);

      expect(seqs(frames)).toEqual([before, before + 1]);
      client.close();
    }),
  );
});

layer(
  serveHttp(
    { address: "127.0.0.1", port: 0 },
    damaged,
    damagedStore,
    idleCommands,
    {
      recheckEvery: Duration.seconds(30),
    },
  ),
  live,
)("a client that asks for history the server can't read", (it) => {
  it.effect("is disconnected with a clear reason, not left waiting", () =>
    Effect.gen(function* () {
      yield* say(damagedStore, "one");
      damaged.run("UPDATE events SET format = 9");
      const url = (yield* baseUrl).replace(/^http/, "ws");
      const closed = yield* Effect.promise(
        () =>
          new Promise<{ code: number; reason: string }>((resolve) => {
            const socket = new WebSocket(`${url}/ws`, {
              headers: { authorization: `Bearer ${damagedToken}` },
            });
            socket.addEventListener("open", () => {
              socket.send(
                encodeFrame({
                  v: 1,
                  type: "resume",
                  cursor: cursor(0, readStreamId(damaged)),
                }),
              );
            });
            socket.addEventListener("close", ({ code, reason }) => {
              resolve({ code, reason });
            });
          }),
      );

      expect(closed).toEqual({
        code: 1011,
        reason: "history could not be read",
      });
    }),
  );
});
