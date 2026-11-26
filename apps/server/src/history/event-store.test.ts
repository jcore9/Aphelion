import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamEvent } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, PubSub, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, onTestFinished } from "vitest";
import { createLogger } from "../log";
import { openStore, readServerId, type Database } from "../store";
import { openEventStore, type EventStore, type NewEvent } from "./event-store";
import { decodeEvent, UnreadableEventError } from "./saved-event";

const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-history-"));
  const path = join(dir, "aphelion.db");
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  const db = openStore(path);
  onTestFinished(() => {
    db.close();
  });
  return { db, path };
};

const logs = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger };
};

const delta = (text: string, turn: string | null = "t1"): NewEvent => ({
  bot: "chief",
  turn,
  event: { type: "text.delta", text },
});

const end = (reason: "completed" | "error", turn = "t1"): NewEvent => ({
  bot: "chief",
  turn,
  event: { type: "turn.end", reason },
});

const open = (db: Database, window?: number) =>
  openEventStore(db, readServerId(db), {
    logger: logs().logger,
    ...(window === undefined ? {} : { window }),
  });

const saved = (db: Database) =>
  db.all("SELECT position, kind, turn FROM events ORDER BY position");

describe("the event store", () => {
  it.effect(
    "saves events in one batch after the window, in order, with the format version",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const store = yield* open(db);
        yield* store.record(delta("a"));
        yield* store.record(delta("b"));
        yield* store.record(end("completed"));
        expect(saved(db)).toEqual([]);
        expect(store.head()).toBe(0);

        yield* TestClock.adjust("49 millis");
        expect(saved(db)).toEqual([]);
        yield* TestClock.adjust("1 millis");

        expect(saved(db)).toEqual([
          { position: 1, kind: "text.delta", turn: "t1" },
          { position: 2, kind: "text.delta", turn: "t1" },
          { position: 3, kind: "turn.end", turn: "t1" },
        ]);
        expect(db.all("SELECT DISTINCT format FROM events")).toEqual([
          { format: 1 },
        ]);
        expect(store.head()).toBe(3);
      }).pipe(Effect.scoped),
  );

  it.effect("saves a full batch at once without waiting for the window", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      for (let i = 0; i < 199; i++) yield* store.record(delta(String(i)));
      expect(store.head()).toBe(0);
      yield* store.record(delta("last"));
      expect(store.head()).toBe(200);
      yield* store.record(delta("next"));
      expect(store.head()).toBe(200);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "hands events to a live subscriber only after they are saved, in position order",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const store = yield* open(db);
        const subscription = yield* store.subscribe;
        yield* store.record(delta("a"));
        yield* store.record(delta("b"));
        expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);

        yield* TestClock.adjust("50 millis");
        const first = yield* PubSub.take(subscription);
        const second = yield* PubSub.take(subscription);

        expect([first.position, second.position]).toEqual([1, 2]);
        expect(first.event).toEqual({ type: "text.delta", text: "a" });
        expect(store.read(0, 10).map(({ position }) => position)).toEqual([
          1, 2,
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps order across batches and gives every event a unique, time-ordered UUIDv7",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const store = yield* open(db);
        for (let i = 0; i < 450; i++) yield* store.record(delta(String(i)));
        yield* TestClock.adjust("50 millis");

        const rows = db.all(
          "SELECT id, position FROM events ORDER BY position",
        );
        expect(rows.map((row) => row["position"])).toEqual(
          Array.from({ length: 450 }, (_, i) => i + 1),
        );
        const ids = rows.map((row) => String(row["id"]));
        expect(new Set(ids).size).toBe(450);
        expect(ids.every((id) => /^[0-9a-f-]{8}-.{4}-7/.test(id))).toBe(true);
        expect(
          store
            .read(0, 1000)
            .map(({ event }) => (event as { text: string }).text),
        ).toEqual(Array.from({ length: 450 }, (_, i) => String(i)));
      }).pipe(Effect.scoped),
  );

  it.effect("opens a turn at its first event and closes it at turn.end", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      yield* store.record(delta("a"));
      yield* TestClock.adjust("50 millis");
      expect(db.all("SELECT id, bot, ended_at, end_reason FROM turns")).toEqual(
        [{ id: "t1", bot: "chief", ended_at: null, end_reason: null }],
      );

      yield* store.record(end("error"));
      yield* TestClock.adjust("50 millis");
      expect(db.all("SELECT ended_at, end_reason FROM turns")).toEqual([
        { ended_at: 50, end_reason: "error" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("saves an event with no turn", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      yield* store.record({
        bot: "chief",
        turn: null,
        event: { type: "error", code: "cli-exited" },
      });
      yield* store.flush;

      expect(saved(db)).toEqual([{ position: 1, kind: "error", turn: null }]);
      expect(db.all("SELECT * FROM turns")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "continues the positions after a restart and never reuses one",
    () =>
      Effect.gen(function* () {
        const { db, path } = tempStore();
        const first = yield* open(db);
        yield* first.record(delta("a"));
        yield* first.flush;
        db.run("DELETE FROM events");

        const reopened = openStore(path);
        const second = yield* open(reopened);
        expect(second.head()).toBe(1);
        expect(second.firstKept()).toBe(2);
        yield* second.record(delta("b"));
        yield* second.flush;
        expect(second.read(0, 10).map(({ position }) => position)).toEqual([2]);
        reopened.close();
      }).pipe(Effect.scoped),
  );

  it.effect("saves what is still waiting when the server shuts down", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const scope = yield* Scope.make();
      const store = yield* open(db).pipe(Scope.provide(scope));
      yield* store.record(delta("a"));
      expect(saved(db)).toEqual([]);

      yield* Scope.close(scope, Exit.void);

      expect(saved(db)).toEqual([
        { position: 1, kind: "text.delta", turn: "t1" },
      ]);
    }),
  );

  it.effect(
    "keeps a batch that fails to save and saves it, in order, on the retry",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { lines, logger } = logs();
        let failures = 1;
        const flaky: Database = {
          ...db,
          transaction: (fn) => {
            if (failures-- > 0) throw new Error("disk full");
            return db.transaction(fn);
          },
        };
        const store: EventStore = yield* openEventStore(
          flaky,
          readServerId(db),
          { logger },
        );
        const subscription = yield* store.subscribe;
        yield* store.record(delta("a"));
        yield* TestClock.adjust("50 millis");
        expect(saved(db)).toEqual([]);
        expect(yield* PubSub.takeUpTo(subscription, 10)).toEqual([]);
        expect(lines.map(({ msg }) => msg)).toEqual([
          "saving bot events failed, so the server will retry",
        ]);

        yield* store.record(delta("b"));
        yield* TestClock.adjust("1 second");

        expect(saved(db).map((row) => row["position"])).toEqual([1, 2]);
        expect(
          store
            .read(0, 10)
            .map(({ event }) => (event as { text: string }).text),
        ).toEqual(["a", "b"]);
        expect((yield* PubSub.take(subscription)).position).toBe(1);
      }).pipe(Effect.scoped),
  );
});

describe("reading a saved event", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "0192f0a0-0000-7000-8000-000000000001",
    position: 7,
    bot: "chief",
    turn: "t1",
    format: 1,
    kind: "tool.end",
    payload: '{"call":"c1","outcome":"ok"}',
    at: 5,
    ...overrides,
  });

  it("turns a format 1 row back into the event", () => {
    const event = streamEvent.parse({
      type: "tool.end",
      call: "c1",
      outcome: "ok",
    });
    expect(decodeEvent(row())).toEqual({
      id: "0192f0a0-0000-7000-8000-000000000001",
      position: 7,
      bot: "chief",
      turn: "t1",
      format: 1,
      event,
      at: 5,
    });
  });

  it("refuses a format this server doesn't know and a payload that doesn't match its format", () => {
    expect(() => decodeEvent(row({ format: 2 }))).toThrow(UnreadableEventError);
    expect(() => decodeEvent(row({ payload: '{"call":"c1"}' }))).toThrow(
      "doesn't match format 1",
    );
    expect(() => decodeEvent(row({ kind: "unknown" }))).toThrow(
      UnreadableEventError,
    );
  });
});
