import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterEnvelope,
  streamEvent,
  type AdapterEnvelope,
} from "@aphelion/plugin-sdk";
import { checkStream } from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Effect, PubSub } from "effect";
import { onTestFinished } from "vitest";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import { openEventStore, type EventStore, type NewEvent } from "./event-store";
import { closeDanglingTurns } from "./repair";

const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-repair-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
};

const boot = (path: string) =>
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

const save = (store: EventStore, events: readonly NewEvent[]) =>
  Effect.gen(function* () {
    for (const event of events) yield* store.record(event);
    yield* store.flush;
  });

const streamOf = (store: EventStore, bot: string): AdapterEnvelope[] =>
  store
    .read(0, 1000)
    .filter((saved) => saved.bot === bot)
    .map((saved, index) =>
      adapterEnvelope.parse({
        seq: index + 1,
        turn: saved.turn,
        event: saved.event,
      }),
    );

const midTurn: NewEvent[] = [
  {
    bot: "chief",
    turn: null,
    event: streamEvent.parse({ type: "session", ref: "s-1" }),
  },
  {
    bot: "chief",
    turn: "t1",
    event: streamEvent.parse({
      type: "tool.start",
      call: "c1",
      tool: "Bash",
      kind: "shell",
    }),
  },
  {
    bot: "chief",
    turn: "t1",
    event: streamEvent.parse({
      type: "permission.request",
      request: "r1",
      call: "c1",
      tool: "Bash",
      kind: "shell",
      pathCount: 0,
      hasCommand: true,
    }),
  },
  {
    bot: "chief",
    turn: "t1",
    event: { type: "text.delta", text: "working" },
  },
];

it.effect(
  "closes a turn that a killed server left open, so the saved stream is valid",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, midTurn);
        expect(checkStream(streamOf(store, "chief"))).not.toEqual([]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      expect(yield* closeDanglingTurns(db, store)).toBe(1);

      expect(checkStream(streamOf(store, "chief"))).toEqual([]);
      expect(
        store.read(4, 100).map(({ turn, event }) => [turn, event.type]),
      ).toEqual([
        ["t1", "error"],
        ["t1", "permission.decision"],
        ["t1", "tool.end"],
        ["t1", "turn.end"],
      ]);
      expect(store.read(4, 1)[0]?.event).toEqual({
        type: "error",
        code: "cli-exited",
      });
      expect(
        db.all("SELECT id, end_reason FROM turns WHERE ended_at IS NULL"),
      ).toEqual([]);
      expect(db.all("SELECT end_reason FROM turns")).toEqual([
        { end_reason: "error" },
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "closes every open turn of every bot, and leaves finished turns alone",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, [
          {
            bot: "chief",
            turn: "t1",
            event: { type: "text.delta", text: "a" },
          },
          {
            bot: "chief",
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
          {
            bot: "chief",
            turn: "t2",
            event: { type: "text.delta", text: "b" },
          },
          {
            bot: "scout",
            turn: "t3",
            event: { type: "text.delta", text: "c" },
          },
        ]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const before = store.head();
      expect(yield* closeDanglingTurns(db, store)).toBe(2);

      expect(
        store
          .read(before, 100)
          .map(({ bot, turn, event }) => [bot, turn, event.type]),
      ).toEqual([
        ["chief", "t2", "error"],
        ["chief", "t2", "turn.end"],
        ["scout", "t3", "error"],
        ["scout", "t3", "turn.end"],
      ]);
      expect(db.all("SELECT id, end_reason FROM turns ORDER BY id")).toEqual([
        { id: "t1", end_reason: "completed" },
        { id: "t2", end_reason: "error" },
        { id: "t3", end_reason: "error" },
      ]);
      expect(checkStream(streamOf(store, "chief"))).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "does nothing on a second boot, and tells a connected client about the repair",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, midTurn);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const live = yield* store.subscribe;
      expect(yield* closeDanglingTurns(db, store)).toBe(1);
      const head = store.head();
      const delivered = yield* PubSub.takeUpTo(live, 20);

      expect(delivered.map(({ position }) => position)).toEqual([5, 6, 7, 8]);
      expect(yield* closeDanglingTurns(db, store)).toBe(0);
      expect(store.head()).toBe(head);
    }).pipe(Effect.scoped),
);

it.effect("adds nothing to a database with no open turn", () =>
  Effect.gen(function* () {
    const { db, store } = yield* boot(tempPath());

    expect(yield* closeDanglingTurns(db, store)).toBe(0);
    expect(store.head()).toBe(0);
  }).pipe(Effect.scoped),
);
