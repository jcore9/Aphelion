import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRef } from "@aphelion/plugin-sdk";
import {
  streamId,
  type EventFrame,
  type LiveFrame,
  type ResyncFrame,
} from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { onTestFinished } from "vitest";
import { createLogger } from "../log";
import { openStore, readServerId, readStreamId } from "../store";
import { openEventStore, type EventLog, type EventStore } from "./event-store";
import { finishRestore } from "../restore";
import {
  follow,
  liveBufferLimit,
  LiveBufferFullError,
  replayPage,
} from "./follow";

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
    yield* store.openTurn("chief", "t1");
    return { db, store };
  });

const say = (store: EventStore, text: string) =>
  store.record({
    bot: "chief",
    run: 1,
    turn: "t1",
    event: { type: "text.delta", text },
  });

const sayAll = (store: EventStore, count: number, from = 1) =>
  Effect.gen(function* () {
    for (let i = 0; i < count; i++) yield* say(store, `m${String(from + i)}`);
    yield* store.flush;
  });

type Sent = EventFrame | ResyncFrame | LiveFrame;

const watch = (log: EventLog, seq: number | null, stream = log.streamId) =>
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
  sent.flatMap((frame) => (frame.type === "event" ? [frame.seq] : []));

const kinds = (sent: readonly Sent[]) => sent.map((frame) => frame.type);

const texts = (sent: readonly Sent[]) =>
  sent.flatMap((frame) =>
    frame.type === "event" &&
    frame.name === "bot.event" &&
    frame.payload.event.type === "text.delta"
      ? [frame.payload.event.text]
      : [],
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

const saySession = (store: EventStore, ref: string) =>
  store.record({
    bot: "chief",
    run: 1,
    turn: null,
    event: { type: "session", ref: sessionRef.parse(ref) },
  });

it.effect("sends live after the replay and before any live event", () =>
  Effect.gen(function* () {
    const { store } = yield* openAt(tempPath());
    yield* sayAll(store, 3);

    const { sent } = yield* watch(store, 1);
    yield* settle;
    expect(kinds(sent)).toEqual(["event", "event", "live"]);
    expect(sent[2]).toEqual({
      v: 1,
      type: "live",
      cursor: { stream: store.streamId, seq: 3 },
    });

    yield* sayAll(store, 1, 4);
    yield* settle;
    expect(kinds(sent)).toEqual(["event", "event", "live", "event"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "sends live with the position of the last saved event, even a hidden one",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* say(store, "m1");
      yield* saySession(store, "s-secret-1");
      yield* store.flush;

      const { sent } = yield* watch(store, 0);
      yield* settle;
      expect(sent.at(-1)).toEqual({
        v: 1,
        type: "live",
        cursor: { stream: store.streamId, seq: 2 },
      });
    }).pipe(Effect.scoped),
);

it.effect("sends live once, after every page of a long replay", () =>
  Effect.gen(function* () {
    const { store } = yield* openAt(tempPath());
    yield* sayAll(store, replayPage + 3);

    const { sent } = yield* watch(store, 0);
    yield* settle;
    expect(kinds(sent).filter((kind) => kind === "live")).toHaveLength(1);
    expect(sent.at(-1)).toEqual({
      v: 1,
      type: "live",
      cursor: { stream: store.streamId, seq: replayPage + 3 },
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "never sends the vendor session ref to a client, whether it replays or follows live",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* say(store, "m1");
      yield* saySession(store, "s-secret-1");
      yield* say(store, "m2");
      yield* store.flush;

      const { sent } = yield* watch(store, 0);
      yield* settle;
      yield* saySession(store, "s-secret-2");
      yield* say(store, "m3");
      yield* store.flush;
      yield* settle;

      expect(positions(sent)).toEqual([1, 3, 5]);
      expect(texts(sent)).toEqual(["m1", "m2", "m3"]);
      expect(JSON.stringify(sent)).not.toContain("s-secret");
      expect(JSON.stringify(sent)).not.toContain('"session"');
    }).pipe(Effect.scoped),
);

it.effect(
  "sends only live to a client that is up to date, and then follows live events",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, 2);
      const { sent } = yield* watch(store, 2);
      yield* settle;
      expect(sent).toEqual([
        { v: 1, type: "live", cursor: { stream: store.streamId, seq: 2 } },
      ]);

      yield* sayAll(store, 1, 3);
      yield* settle;
      expect(positions(sent)).toEqual([3]);
      expect(kinds(sent)).toEqual(["live", "event"]);
    }).pipe(Effect.scoped),
);

it.effect(
  "sends one resync with the current head, and no live events after it",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      yield* sayAll(store, 3);
      const head = { stream: store.streamId, seq: 3 };

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
        { v: 1, type: "resync", cursor: { stream: store.streamId, seq: 5 } },
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
      return { stream: store.streamId, seq: 2 };
    }).pipe(Effect.scoped);

    const { store } = yield* openAt(path);
    yield* sayAll(store, 2, 4);
    expect(store.streamId).toBe(before.stream);

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

it.effect(
  "gives a cursor saved before a restore a resync, and keeps the server ID",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      const before = yield* Effect.gen(function* () {
        const { store, db } = yield* openAt(path);
        yield* sayAll(store, 3);
        const saved = { stream: store.streamId, seq: 2 };
        finishRestore(db);
        return { saved, serverId: store.serverId };
      }).pipe(Effect.scoped);

      const { store, db } = yield* openAt(path);
      expect(store.serverId).toBe(before.serverId);
      expect(readServerId(db)).toBe(before.serverId);
      expect(store.streamId).not.toBe(before.saved.stream);
      yield* sayAll(store, 2, 4);

      const { sent } = yield* watch(
        store,
        before.saved.seq,
        before.saved.stream,
      );
      yield* settle;
      expect(sent).toEqual([
        {
          v: 1,
          type: "resync",
          cursor: { stream: readStreamId(db), seq: 5 },
        },
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "fails a client whose live buffer passes the limit and keeps serving the others",
  () =>
    Effect.gen(function* () {
      const { store } = yield* openAt(tempPath());
      const stuck = yield* Deferred.make<undefined>();
      const stalled = yield* follow(
        store,
        { stream: streamId.parse(store.streamId), seq: 0 },
        () => Deferred.await(stuck),
      ).pipe(Effect.flip, Effect.forkScoped);
      const healthy = yield* watch(store, 0);
      yield* settle;

      yield* sayAll(store, liveBufferLimit + 5);
      const error = yield* Fiber.join(stalled);
      yield* Effect.repeat(Effect.yieldNow, {
        until: () => positions(healthy.sent).length === liveBufferLimit + 5,
      });

      expect(error).toBeInstanceOf(LiveBufferFullError);
      expect(positions(healthy.sent)).toHaveLength(liveBufferLimit + 5);
    }).pipe(Effect.scoped),
);
