import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandId,
  type CommandId,
  type CommandName,
} from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, onTestFinished } from "vitest";
import { deviceId } from "../devices";
import { createLogger } from "../log";
import { openStore } from "../store";
import { openCommandLedger, type Outcome } from "./ledger";

const day = 24 * 60 * 60 * 1000;

const tempStore = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-commands-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  const path = join(dir, "aphelion.db");
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

const laptop = deviceId.parse("0123456789abcdef");
const phone = deviceId.parse("fedcba9876543210");
const id = (value: string): CommandId => commandId.parse(value);
const entry = (
  command: string,
  device = laptop,
  name: CommandName = "bot.prompt",
) => ({ device, id: id(command), name }) as const;

const counting = (result: unknown = { turn: "t1" }) => {
  const ran = { count: 0 };
  const apply: Effect.Effect<Outcome> = Effect.sync(() => {
    ran.count += 1;
    return { ok: true, result };
  });
  return { ran, apply };
};

const open = (db: ReturnType<typeof tempStore>["db"]) =>
  openCommandLedger(db, logs().logger);

describe("the command ledger", () => {
  it.effect(
    "runs a command once and answers a repeat with the saved result",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        const { ran, apply } = counting();

        const first = yield* ledger.run(entry("c1"), apply);
        const again = yield* ledger.run(entry("c1"), apply);

        expect(first).toEqual({ ok: true, result: { turn: "t1" } });
        expect(again).toEqual(first);
        expect(ran.count).toBe(1);
        expect(db.all("SELECT state, result FROM commands")).toEqual([
          { state: "done", result: '{"turn":"t1"}' },
        ]);
      }),
  );

  it.effect("saves a failure and answers a repeat with it", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const ledger = yield* open(db);
      const ran = { count: 0 };
      const refuse: Effect.Effect<Outcome> = Effect.sync(() => {
        ran.count += 1;
        return { ok: false, code: "bot-busy" };
      });

      const first = yield* ledger.run(entry("c1"), refuse);
      const again = yield* ledger.run(entry("c1"), refuse);

      expect(first).toEqual({ ok: false, code: "bot-busy" });
      expect(again).toEqual(first);
      expect(ran.count).toBe(1);
      expect(db.all("SELECT state, result FROM commands")).toEqual([
        { state: "failed", result: "bot-busy" },
      ]);
    }),
  );

  it.effect(
    "makes a repeat that arrives while the command runs wait for it",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        const gate = yield* Deferred.make<undefined>();
        const ran = { count: 0 };
        const slow: Effect.Effect<Outcome> = Deferred.await(gate).pipe(
          Effect.map(() => {
            ran.count += 1;
            return { ok: true, result: { turn: "t1" } } as const;
          }),
        );

        const first = yield* Effect.forkChild(ledger.run(entry("c1"), slow));
        const second = yield* Effect.forkChild(ledger.run(entry("c1"), slow));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);

        expect(yield* Fiber.join(first)).toEqual(yield* Fiber.join(second));
        expect(ran.count).toBe(1);
      }),
  );

  it.effect(
    "finishes a command whose caller went away, and answers the repeat",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        const gate = yield* Deferred.make<undefined>();
        const ran = { count: 0 };
        const slow: Effect.Effect<Outcome> = Deferred.await(gate).pipe(
          Effect.map(() => {
            ran.count += 1;
            return { ok: true, result: { turn: "t1" } } as const;
          }),
        );

        const caller = yield* Effect.forkChild(ledger.run(entry("c1"), slow));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(gate, undefined);

        expect(yield* ledger.run(entry("c1"), slow)).toEqual({
          ok: true,
          result: { turn: "t1" },
        });
        expect(ran.count).toBe(1);
      }),
  );

  it.effect("keeps two devices that use the same command id apart", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const ledger = yield* open(db);
      const first = counting({ turn: "from-laptop" });
      const second = counting({ turn: "from-phone" });

      const fromLaptop = yield* ledger.run(entry("c1", laptop), first.apply);
      const fromPhone = yield* ledger.run(entry("c1", phone), second.apply);
      const laptopAgain = yield* ledger.run(entry("c1", laptop), second.apply);

      expect(fromLaptop).toEqual({ ok: true, result: { turn: "from-laptop" } });
      expect(fromPhone).toEqual({ ok: true, result: { turn: "from-phone" } });
      expect(laptopAgain).toEqual(fromLaptop);
      expect([first.ran.count, second.ran.count]).toEqual([1, 1]);
    }),
  );

  it.effect("refuses an id that a different command already used", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const ledger = yield* open(db);
      const first = counting();
      const other = counting();

      yield* ledger.run(entry("c1", laptop, "bot.prompt"), first.apply);
      const reused = yield* ledger.run(
        entry("c1", laptop, "bot.cancel"),
        other.apply,
      );

      expect(reused).toEqual({ ok: false, code: "id-reused" });
      expect(other.ran.count).toBe(0);
      expect(db.all("SELECT name, state FROM commands")).toEqual([
        { name: "bot.prompt", state: "done" },
      ]);
    }),
  );

  it.effect(
    "saves a command that threw as a failure and doesn't run it again",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { lines, logger } = logs();
        const ledger = yield* openCommandLedger(db, logger);
        const ran = { count: 0 };
        const broken: Effect.Effect<Outcome> = Effect.sync(() => {
          ran.count += 1;
          throw new Error("the prompt was: launch codes");
        });

        const first = yield* ledger.run(entry("c1"), broken);
        const again = yield* ledger.run(entry("c1"), broken);

        expect(first).toEqual({ ok: false, code: "internal" });
        expect(again).toEqual(first);
        expect(ran.count).toBe(1);
        expect(JSON.stringify(lines)).not.toContain("launch codes");
      }),
  );

  it.effect("doesn't run a command it couldn't write down first", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const ledger = yield* open(db);
      const { ran, apply } = counting();
      db.exec("DROP TABLE commands");

      expect(yield* ledger.run(entry("c1"), apply)).toEqual({
        ok: false,
        code: "internal",
      });
      expect(ran.count).toBe(0);
    }),
  );
});

describe("the command ledger after a restart", () => {
  it.effect(
    "answers a repeat with the saved result and doesn't run it again",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const first = counting();
        const second = counting({ turn: "t2" });
        const before = yield* Scope.make();
        const ledger = yield* open(db).pipe(Scope.provide(before));
        yield* ledger.run(entry("c1"), first.apply);
        yield* Scope.close(before, Exit.void);

        const restarted = yield* open(db);
        const repeat = yield* restarted.run(entry("c1"), second.apply);

        expect(repeat).toEqual({ ok: true, result: { turn: "t1" } });
        expect(second.ran.count).toBe(0);
      }),
  );

  it.effect(
    "answers a command the crash left running with interrupted, and never runs it",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const before = yield* Scope.make();
        const ledger = yield* open(db).pipe(Scope.provide(before));
        yield* Effect.forkChild(ledger.run(entry("c1"), Effect.never));
        yield* Effect.yieldNow;
        expect(db.all("SELECT state FROM commands")).toEqual([
          { state: "running" },
        ]);
        yield* Scope.close(before, Exit.void);
        const { ran, apply } = counting();

        const restarted = yield* open(db);
        const repeat = yield* restarted.run(entry("c1"), apply);

        expect(repeat).toEqual({ ok: false, code: "interrupted" });
        expect(ran.count).toBe(0);
        expect(db.all("SELECT state, result FROM commands")).toEqual([
          { state: "failed", result: "interrupted" },
        ]);
      }),
  );

  it.effect(
    "keeps a command that really is running, because its row has no result yet",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        yield* Effect.forkChild(ledger.run(entry("c1"), Effect.never));
        yield* Effect.yieldNow;

        yield* TestClock.adjust(2 * day);

        expect(db.all("SELECT state FROM commands")).toEqual([
          { state: "running" },
        ]);
      }),
  );
});

describe("the command ledger and the 24-hour limit", () => {
  it.effect(
    "answers a repeat from the saved result until 24 hours have passed",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        const { ran, apply } = counting();
        yield* TestClock.adjust("30 minutes");
        yield* ledger.run(entry("c1"), apply);

        yield* TestClock.adjust(day - 1);
        yield* ledger.run(entry("c1"), apply);
        expect(ran.count).toBe(1);

        yield* TestClock.adjust(1);
        yield* ledger.run(entry("c1"), apply);
        expect(ran.count).toBe(2);
        expect(db.all("SELECT state FROM commands")).toEqual([
          { state: "done" },
        ]);
      }),
  );

  it.effect("deletes rows older than 24 hours at boot", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const before = yield* Scope.make();
      const ledger = yield* open(db).pipe(Scope.provide(before));
      yield* ledger.run(entry("old"), counting().apply);
      yield* TestClock.adjust(day / 2);
      yield* ledger.run(entry("recent"), counting().apply);
      yield* Scope.close(before, Exit.void);
      yield* TestClock.adjust(day / 2);

      yield* open(db);

      expect(db.all("SELECT id FROM commands")).toEqual([{ id: "recent" }]);
    }),
  );

  it.effect(
    "deletes old rows every hour while the server runs, but never a running one",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        yield* Effect.forkChild(ledger.run(entry("slow"), Effect.never));
        yield* ledger.run(entry("done"), counting().apply);
        yield* Effect.yieldNow;

        yield* TestClock.adjust(day);
        expect(db.all("SELECT id FROM commands ORDER BY id")).toEqual([
          { id: "slow" },
        ]);
      }),
  );
});
