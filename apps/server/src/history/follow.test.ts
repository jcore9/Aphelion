import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  streamId,
  type EventFrame,
  type ResyncFrame,
} from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { onTestFinished } from "vitest";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { openEventStore, type EventLog, type EventStore } from "./event-store";
import { follow, replayPage } from "./follow";

const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-follow-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

const openAt = (path: string) =>
  Effect.gen(function* () {
    const db = openStore(path);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        db.close();
      }),
    );
    const store = yield* openEventStore(db, readServerId(db), {
      logger: createLogger({ write: () => undefined }),
    });
    return { db, store };
  });

const say = (store: EventStore, text: string) =>
  store.record({
    bot: "chief",
    turn: "t1",
    event: { type: "text.delta", text },
  });

const sayAll = (store: EventStore, count: number, from = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) yield* say(store, `m${String(from + i)}`);
    yield* store.flush;
  });

type Sent = EventFrame | ResyncFrame;

const watch = (log: EventLog, seq: number | null, stream = log.serverId) =>
  Effect.gen(function* () {
    const sent: Sent[] = [];
    const fiber = yield* follow(
      log,
      seq === null ? null : { stream: streamId.parse(stream), seq },
      (frame) =>
        Effect.sync(() => {
          sent.push(frame);
        }),
    ).pipe(Effect.forkScoped);
    return { sent, fiber };
  });

const settle = Effect.repeat(Effect.yieldNow, { times: 20 });

const positions = (sent: readonly Sent[]) =>
  sent.map((frame) => (frame.type === "event" ? frame.seq : -1));

const texts = (sent: readonly Sent[]) =>
  sent.map((frame) =>
    frame.type === "event" &&
    frame.name === "bot.event" &&
    frame.payload.event.type === "text.delta"
      ? frame.payload.event.text
      : "",
  );

it.effect(
  "replays what the client missed, then follows live events in order",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, 3);

      const { sent } = yield* watch(store, 1);
      yield* settle;
      expect(texts(sent)).toEqual(["m2", "m3"]);

      yield* sayAll(store, 2, 4);
      yield* settle;
      expect(texts(sent)).toEqual(["m2", "m3", "m4", "m5"]);
      expect(sent[0]).toEqual({
        v: 1,
        type: "event",
        seq: 2,
        name: "bot.event",
        payload: {
          bot: "chief",
          turn: "t1",
          format: 1,
          event: { type: "text.delta", text: "m2" },
        },
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "sends nothing to a client that is up to date, and then follows live events",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, 2);
      const { sent } = yield* watch(store, 2);
      yield* settle;
      expect(sent).toEqual([]);

      yield* sayAll(store, 1, 3);
      yield* settle;
      expect(positions(sent)).toEqual([3]);
    }).pipe(Effect.scoped),
);

it.effect(
  "sends one resync with the current head, and no live events after it",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, 3);
      const head = { stream: store.serverId, seq: 3 };

      const cases: [string, number | null, string?][] = [
        ["no cursor", null],
        ["a cursor from another stream", 1, "another-stream"],
        ["a cursor ahead of the server", 4],
      ];
      for (const [, seq, stream] of cases) {
        const { sent, fiber } = yield* watch(store, seq, stream);
        yield* settle;
        expect(sent).toEqual([{ v: 1, type: "resync", cursor: head }]);
        yield* Fiber.await(fiber);
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "sends a resync to a cursor behind the oldest saved event, and replays from the one just before it",
  () =>
    Effect.gen(function* () {
      const { store, db } = yield* openAt(tempPath());
      yield* sayAll(store, 5);
      db.run("DELETE FROM events WHERE position < 3");

      const behind = yield* watch(store, 1);
      yield* settle;
      expect(behind.sent).toEqual([
        { v: 1, type: "resync", cursor: { stream: store.serverId, seq: 5 } },
      ]);

      const adjacent = yield* watch(store, 2);
      yield* settle;
      expect(positions(adjacent.sent)).toEqual([3, 4, 5]);
    }).pipe(Effect.scoped),
);

it.effect(
  "replays more than one page, then the live events, with no gap and no repeat",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      const total = replayPage * 2 + 7;
      yield* sayAll(store, total);

      const { sent } = yield* watch(store, 0);
      yield* sayAll(store, 3, total + 1);
      yield* settle;

      expect(positions(sent)).toEqual(
        Array.from({ length: total + 3 }, (_, i) => i + 1),
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "loses and repeats nothing when events are saved while the replay runs",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, replayPage + 10);
      let next = replayPage + 11;
      let reads = 0;
      const racing: EventLog = {
        ...store,
        read: (after, limit) => {
          const page = store.read(after, limit);
          if (reads++ < 2) {
            Effect.runSync(sayAll(store, 4, next));
            next += 4;
          }
          return page;
        },
      };

      const { sent } = yield* watch(racing, 0);
      yield* settle;
      yield* sayAll(store, 2, next);
      yield* settle;

      const seen = positions(sent);
      expect(seen).toEqual(
        Array.from({ length: store.head() }, (_, i) => i + 1),
      );
      expect(store.head()).toBe(replayPage + 10 + 8 + 2);
    }).pipe(Effect.scoped),
);

it.effect("resumes a client's cursor after the server restarts", () =>
  Effect.gen(function* () {
    const path = tempPath();
    const before = yield* Effect.gen(function* () {
      const { store } = yield* openAt(path);
      yield* sayAll(store, 3);
      return { stream: store.serverId, seq: 2 };
    }).pipe(Effect.scoped);

    const { store } = yield* openAt(path);
    yield* sayAll(store, 2, 4);
    expect(store.serverId).toBe(before.stream);

    const { sent } = yield* watch(store, before.seq);
    yield* settle;
    expect(texts(sent)).toEqual(["m3", "m4", "m5"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "fails when a saved event can't be read, so the caller can end the connection",
  () =>
    Effect.gen(function* () {
      const { store, db } = yield* openAt(tempPath());
      yield* sayAll(store, 2);
      db.run("UPDATE events SET format = 9 WHERE position = 2");

      const { fiber } = yield* watch(store, 0);
      const exit = yield* Fiber.await(fiber);

      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.scoped),
);
