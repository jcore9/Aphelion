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

const quiet = createLogger({ write: () => undefined });

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger };
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
      logger: quiet,
    });
    return { db, store };
  });

const save = (store: EventStore, events: readonly NewEvent[]) =>
  Effect.gen(function* () {
    for (const event of events) {
      if (event.turn !== null) yield* store.openTurn(event.bot, event.turn);
      yield* store.record(event);
    }
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
    run: 1,
    turn: null,
    event: streamEvent.parse({ type: "session", ref: "s-1" }),
  },
  {
    bot: "chief",
    run: 1,
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
    run: 1,
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
    run: 1,
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
      expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(1);

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
            run: 1,
            turn: "t1",
            event: { type: "text.delta", text: "a" },
          },
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
          {
            bot: "chief",
            run: 1,
            turn: "t2",
            event: { type: "text.delta", text: "b" },
          },
          {
            bot: "scout",
            run: 1,
            turn: "t3",
            event: { type: "text.delta", text: "c" },
          },
        ]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const before = store.head();
      expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(2);

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
      expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(1);
      const head = store.head();
      const delivered = yield* PubSub.takeUpTo(live, 20);

      expect(delivered.map(({ position }) => position)).toEqual([5, 6, 7, 8]);
      expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(0);
      expect(store.head()).toBe(head);
    }).pipe(Effect.scoped),
);

it.effect("leaves a refused turn alone, with its events kept", () =>
  Effect.gen(function* () {
    const path = tempPath();
    yield* Effect.gen(function* () {
      const { store } = yield* boot(path);
      yield* save(store, [midTurn[3] as NewEvent]);
      yield* store.endTurn("t1", "refused");
    }).pipe(Effect.scoped);

    const { db, store } = yield* boot(path);
    expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
      turns: 0,
      calls: 0,
    });
    expect(store.read(0, 100)).toHaveLength(1);
    expect(db.all("SELECT end_reason FROM turns")).toEqual([
      { end_reason: "refused" },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("adds nothing to a database with no open turn", () =>
  Effect.gen(function* () {
    const { db, store } = yield* boot(tempPath());

    expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(0);
    expect(store.head()).toBe(0);
  }).pipe(Effect.scoped),
);

const backgroundCall = (run: number, call: string, turn: string): NewEvent => ({
  bot: "chief",
  run,
  turn,
  event: streamEvent.parse({
    type: "tool.start",
    call,
    tool: "Bash",
    kind: "shell",
  }),
});

const streamOfRun = (store: EventStore, run: number): AdapterEnvelope[] =>
  store
    .read(0, 1000)
    .filter((saved) => saved.bot === "chief" && saved.run === run)
    .map((saved, index) =>
      adapterEnvelope.parse({
        seq: index + 1,
        turn: saved.turn,
        event: saved.event,
      }),
    );

it.effect(
  "closes a call that outlived its finished turn when its process is gone, and the stream passes checkStream",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, [
          backgroundCall(1, "c1", "t1"),
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
          {
            bot: "chief",
            run: 1,
            turn: "t2",
            event: { type: "text.delta", text: "next" },
          },
        ]);
        expect(checkStream(streamOfRun(store, 1))).not.toEqual([]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const before = store.head();
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 1,
        calls: 1,
      });

      expect(
        store
          .read(before, 100)
          .map(({ run, turn, event }) => [run, turn, event.type]),
      ).toEqual([
        [1, "t2", "error"],
        [1, "t2", "turn.end"],
        [1, "t1", "tool.end"],
      ]);
      expect(checkStream(streamOfRun(store, 1))).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "closes a background call when no turn is open, and tells runs with the same call id apart",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, [
          backgroundCall(1, "c1", "t1"),
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
          backgroundCall(2, "c1", "t2"),
          {
            bot: "chief",
            run: 2,
            turn: "t2",
            event: streamEvent.parse({
              type: "tool.end",
              call: "c1",
              outcome: "ok",
            }),
          },
          {
            bot: "chief",
            run: 2,
            turn: "t2",
            event: { type: "turn.end", reason: "completed" },
          },
        ]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const before = store.head();
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 0,
        calls: 1,
      });

      expect(
        store
          .read(before, 100)
          .map(({ run, turn, event }) => [run, turn, event.type]),
      ).toEqual([[1, "t1", "tool.end"]]);
      expect(checkStream(streamOfRun(store, 1))).toEqual([]);
      expect(checkStream(streamOfRun(store, 2))).toEqual([]);
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 0,
        calls: 0,
      });
    }).pipe(Effect.scoped),
);

it.effect(
  "tells two server starts apart when both numbered their run 1 and reused a call id",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, [
          backgroundCall(1, "c1", "t1"),
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
        ]);
      }).pipe(Effect.scoped);
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* save(store, [
          backgroundCall(1, "c1", "t2"),
          {
            bot: "chief",
            run: 1,
            turn: "t2",
            event: streamEvent.parse({
              type: "tool.end",
              call: "c1",
              outcome: "ok",
            }),
          },
          {
            bot: "chief",
            run: 1,
            turn: "t2",
            event: { type: "turn.end", reason: "completed" },
          },
        ]);
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      const before = store.head();
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 0,
        calls: 1,
      });

      const repaired = store.read(before, 100);
      expect(repaired.map(({ turn, event }) => [turn, event.type])).toEqual([
        ["t1", "tool.end"],
      ]);
      expect(repaired[0]?.epoch).toBe(1);
      expect(
        db.all("SELECT DISTINCT epoch FROM events ORDER BY epoch"),
      ).toEqual([{ epoch: 1 }, { epoch: 2 }]);
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 0,
        calls: 0,
      });
    }).pipe(Effect.scoped),
);

const insertRaw = (
  db: ReturnType<typeof openStore>,
  row: {
    readonly position: number;
    readonly turn: string;
    readonly format: number;
    readonly kind: string;
    readonly payload: string;
  },
) => {
  db.run(
    `INSERT INTO events (id, server_id, position, bot, turn, run, epoch, format, kind, payload, at)
     VALUES (?, ?, ?, 'chief', ?, 1, 1, ?, ?, ?, 0)`,
    [
      `0192f0a0-0000-7000-8000-00000000000${String(row.position)}`,
      readServerId(db),
      row.position,
      row.turn,
      row.format,
      row.kind,
      row.payload,
    ],
  );
};

it.effect(
  "skips a saved row it can't decode, logs its id and format, and starts anyway",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { db, store } = yield* boot(path);
        yield* save(store, [
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "text.delta", text: "a" },
          },
          {
            bot: "chief",
            run: 1,
            turn: "t1",
            event: { type: "turn.end", reason: "completed" },
          },
        ]);
        insertRaw(db, {
          position: 3,
          turn: "t1",
          format: 2,
          kind: "tool.start",
          payload: '{"callId":"c9","tool":"Bash","kind":"shell"}',
        });
        insertRaw(db, {
          position: 4,
          turn: "t1",
          format: 1,
          kind: "tool.start",
          payload: '{"call":"bad call id!","tool":"Bash","kind":"shell"}',
        });
        db.run(
          "UPDATE server_meta SET value = '5' WHERE key = 'next_position'",
        );
      }).pipe(Effect.scoped);

      const { lines, logger } = capture();
      const { db, store } = yield* boot(path);
      const before = store.head();
      expect(yield* closeDanglingTurns(db, store, logger)).toEqual({
        turns: 0,
        calls: 0,
      });

      expect(store.head()).toBe(before);
      expect(
        lines.filter(
          ({ msg }) =>
            msg === "boot repair skipped a saved event it can't read",
        ),
      ).toEqual([
        expect.objectContaining({
          id: "0192f0a0-0000-7000-8000-000000000003",
          format: 2,
        }),
        expect.objectContaining({
          id: "0192f0a0-0000-7000-8000-000000000004",
          format: 1,
        }),
      ]);
      expect(JSON.stringify(lines)).not.toContain("c9");
      expect(JSON.stringify(lines)).not.toContain("bad call id");
      expect(JSON.stringify(lines)).not.toContain('"null"');
    }).pipe(Effect.scoped),
);

it.effect("still closes an open turn that has a row it can't decode", () =>
  Effect.gen(function* () {
    const path = tempPath();
    yield* Effect.gen(function* () {
      const { db, store } = yield* boot(path);
      yield* save(store, [
        {
          bot: "chief",
          run: 1,
          turn: "t1",
          event: { type: "text.delta", text: "a" },
        },
      ]);
      insertRaw(db, {
        position: 2,
        turn: "t1",
        format: 2,
        kind: "text.delta",
        payload: '{"words":"b"}',
      });
      db.run("UPDATE server_meta SET value = '3' WHERE key = 'next_position'");
    }).pipe(Effect.scoped);

    const { lines, logger } = capture();
    const { db, store } = yield* boot(path);
    expect((yield* closeDanglingTurns(db, store, logger)).turns).toBe(1);

    expect(
      store.read(2, 10).map(({ turn, event }) => [turn, event.type]),
    ).toEqual([
      ["t1", "error"],
      ["t1", "turn.end"],
    ]);
    expect(lines).toContainEqual(expect.objectContaining({ format: 2 }));
  }).pipe(Effect.scoped),
);

it.effect(
  "has nothing extra to repair after an event named a turn the server never started",
  () =>
    Effect.gen(function* () {
      const path = tempPath();
      yield* Effect.gen(function* () {
        const { store } = yield* boot(path);
        yield* store.openTurn("chief", "t1");
        yield* store.record({
          bot: "chief",
          run: 1,
          turn: "t1x",
          event: { type: "text.delta", text: "typo" },
        });
        yield* store.record({
          bot: "chief",
          run: 1,
          turn: "t1",
          event: { type: "text.delta", text: "right" },
        });
        yield* store.record({
          bot: "chief",
          run: 1,
          turn: "t1",
          event: { type: "turn.end", reason: "completed" },
        });
        yield* store.flush;
      }).pipe(Effect.scoped);

      const { db, store } = yield* boot(path);
      expect(yield* closeDanglingTurns(db, store, quiet)).toEqual({
        turns: 0,
        calls: 0,
      });
      expect(db.all("SELECT id FROM turns")).toEqual([{ id: "t1" }]);
      expect(checkStream(streamOf(store, "chief"))).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect("closes a turn that was started but never produced an event", () =>
  Effect.gen(function* () {
    const path = tempPath();
    yield* Effect.gen(function* () {
      const { store } = yield* boot(path);
      yield* store.openTurn("chief", "t1");
    }).pipe(Effect.scoped);

    const { db, store } = yield* boot(path);
    expect((yield* closeDanglingTurns(db, store, quiet)).turns).toBe(1);

    expect(store.read(0, 10).map(({ event }) => event.type)).toEqual([
      "error",
      "turn.end",
    ]);
    expect(checkStream(streamOf(store, "chief"))).toEqual([]);
  }).pipe(Effect.scoped),
);
