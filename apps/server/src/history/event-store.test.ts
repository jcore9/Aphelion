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
  run: 1,
  turn,
  event: { type: "text.delta", text },
});

const end = (reason: "completed" | "error", turn = "t1"): NewEvent => ({
  bot: "chief",
  run: 1,
  turn,
  event: { type: "turn.end", reason },
});

const open = (db: Database, window?: number) =>
  Effect.gen(function* () {
    const store = yield* openEventStore(db, readServerId(db), {
      logger: logs().logger,
      ...(window === undefined ? {} : { window }),
    });
    yield* store.openTurn("chief", "t1");
    return store;
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

  it.effect(
    "records a turn when the server allocates it and closes it at turn.end",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const store = yield* open(db);
        expect(
          db.all("SELECT id, bot, ended_at, end_reason FROM turns"),
        ).toEqual([
          { id: "t1", bot: "chief", ended_at: null, end_reason: null },
        ]);

        yield* store.record(delta("a"));
        yield* TestClock.adjust("50 millis");
        yield* store.record(end("error"));
        yield* TestClock.adjust("50 millis");
        expect(db.all("SELECT ended_at, end_reason FROM turns")).toEqual([
          { ended_at: 50, end_reason: "error" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses an event that names a turn the server never started, logs a fixed line, and opens no turn",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { lines, logger } = logs();
        const store = yield* openEventStore(db, readServerId(db), { logger });
        yield* store.openTurn("chief", "t1");
        yield* store.record(delta("typo", "t1x"));
        yield* store.record(delta("right"));
        yield* store.record(end("completed"));
        yield* store.flush;

        expect(saved(db)).toEqual([
          { position: 1, kind: "text.delta", turn: "t1" },
          { position: 2, kind: "turn.end", turn: "t1" },
        ]);
        expect(db.all("SELECT id FROM turns")).toEqual([{ id: "t1" }]);
        expect(lines).toContainEqual(
          expect.objectContaining({
            msg: "bot events for a turn the server didn't start were not saved",
            count: 1,
          }),
        );
        expect(JSON.stringify(lines)).not.toContain("t1x");
        expect(JSON.stringify(lines)).not.toContain("typo");
      }).pipe(Effect.scoped),
  );

  it.effect("still saves a late event for a turn that already ended", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      yield* store.record(end("completed"));
      yield* store.flush;
      yield* store.record({
        bot: "chief",
        run: 1,
        turn: "t1",
        event: streamEvent.parse({
          type: "tool.end",
          call: "c1",
          outcome: "ok",
        }),
      });
      yield* store.flush;

      expect(saved(db).map((row) => row["kind"])).toEqual([
        "turn.end",
        "tool.end",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "ends a refused turn and keeps its events, whether they were saved before or after the refusal",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const store = yield* open(db);
        yield* store.openTurn("chief", "t2");
        yield* store.record(delta("a", "t1"));
        yield* store.endTurn("t1", "refused");
        yield* store.flush;
        yield* store.record(delta("b", "t2"));
        yield* store.flush;
        yield* store.endTurn("t2", "refused");

        expect(
          db.all("SELECT id, end_reason, ended_at IS NULL AS open FROM turns"),
        ).toEqual([
          { id: "t1", end_reason: "refused", open: 0 },
          { id: "t2", end_reason: "refused", open: 0 },
        ]);
        expect(saved(db).map((row) => row["turn"])).toEqual(["t1", "t2"]);
      }).pipe(Effect.scoped),
  );

  it.effect("never ends a turn twice", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      yield* store.record(end("completed"));
      yield* store.flush;
      yield* store.endTurn("t1", "refused");

      expect(db.all("SELECT end_reason FROM turns")).toEqual([
        { end_reason: "completed" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "advances the boot epoch once for each opened store and stamps its events with it",
    () =>
      Effect.gen(function* () {
        const { db, path } = tempStore();
        const first = yield* open(db);
        yield* first.record(delta("a"));
        yield* first.flush;
        const reopened = openStore(path);
        const second = yield* open(reopened);
        yield* second.record(delta("b"));
        yield* second.flush;

        expect([first.epoch, second.epoch]).toEqual([1, 2]);
        expect(
          db.all("SELECT position, epoch FROM events ORDER BY position"),
        ).toEqual([
          { position: 1, epoch: 1 },
          { position: 2, epoch: 2 },
        ]);
        expect(second.read(0, 10).map(({ epoch }) => epoch)).toEqual([1, 2]);
        reopened.close();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses an event for another bot's turn, logs it, and saves the rest without a gap",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { lines, logger } = logs();
        const store = yield* openEventStore(db, readServerId(db), { logger });
        const scout = (event: NewEvent["event"], turn: string): NewEvent => ({
          bot: "scout",
          run: 1,
          turn,
          event,
        });
        yield* store.openTurn("chief", "t1");
        yield* store.openTurn("scout", "t2");
        yield* store.record(delta("a"));
        yield* store.record(end("completed"));
        yield* store.record(scout({ type: "text.delta", text: "x" }, "t1"));
        yield* store.record(scout({ type: "turn.end", reason: "error" }, "t1"));
        yield* store.record(scout({ type: "text.delta", text: "b" }, "t2"));
        yield* store.flush;

        expect(saved(db)).toEqual([
          { position: 1, kind: "text.delta", turn: "t1" },
          { position: 2, kind: "turn.end", turn: "t1" },
          { position: 3, kind: "text.delta", turn: "t2" },
        ]);
        expect(
          db.all("SELECT id, bot, end_reason FROM turns ORDER BY id"),
        ).toEqual([
          { id: "t1", bot: "chief", end_reason: "completed" },
          { id: "t2", bot: "scout", end_reason: null },
        ]);
        expect(store.head()).toBe(3);
        expect(lines).toContainEqual(
          expect.objectContaining({
            msg: "bot events for another bot's turn were not saved",
            count: 2,
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("saves an event with no turn", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const store = yield* open(db);
      yield* store.record({
        bot: "chief",
        run: 1,
        turn: null,
        event: { type: "error", code: "cli-exited" },
      });
      yield* store.flush;

      expect(saved(db)).toEqual([{ position: 1, kind: "error", turn: null }]);
      expect(db.all("SELECT id FROM turns")).toEqual([{ id: "t1" }]);
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
        yield* store.openTurn("chief", "t1");
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
    run: 1,
    epoch: 3,
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
      run: 1,
      epoch: 3,
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
