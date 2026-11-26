import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandId,
  type CommandId,
  type CommandName,
} from "@aphelion/protocol";
import { expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, onTestFinished } from "vitest";
import { deviceId } from "../devices";
import { createLogger } from "../log";
import { openStore, type Database } from "../store";
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

const failingWrites = (db: Database, matching: string, failures: number) => {
  const left = { count: failures };
  const wrapped: Database = {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params) => {
      if (sql.includes(matching) && left.count > 0) {
        left.count -= 1;
        throw new Error("database is locked");
      }
      db.run(sql, params);
    },
    all: (sql, params) => db.all(sql, params),
    transaction: (fn) => db.transaction(fn),
    close: () => {
      db.close();
    },
  };
  return { wrapped, left };
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

  it.effect(
    "runs and settles a command whose caller is interrupted as the claim commits",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const target: { fiber?: Fiber.Fiber<unknown, unknown> } = {};
        const interrupting: Database = {
          exec: (sql) => {
            db.exec(sql);
          },
          run: (sql, params) => {
            db.run(sql, params);
            if (sql.startsWith("INSERT INTO commands")) {
              target.fiber?.interruptUnsafe();
            }
          },
          all: (sql, params) => db.all(sql, params),
          transaction: (fn) => db.transaction(fn),
          close: () => {
            db.close();
          },
        };
        const ledger = yield* openCommandLedger(interrupting, logs().logger);
        const gate = yield* Deferred.make<undefined>();
        const ran = { count: 0 };
        const slow: Effect.Effect<Outcome> = Deferred.await(gate).pipe(
          Effect.map(() => {
            ran.count += 1;
            return { ok: true, result: { turn: "t1" } } as const;
          }),
        );

        const caller = yield* Effect.forkChild(
          Effect.withFiber((fiber) => {
            target.fiber = fiber;
            return ledger.run(entry("c1"), slow);
          }),
        );
        const exit = yield* Fiber.await(caller);
        yield* Deferred.succeed(gate, undefined);

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* ledger.run(entry("c1"), slow)).toEqual({
          ok: true,
          result: { turn: "t1" },
        });
        expect(ran.count).toBe(1);
        expect(db.all("SELECT state FROM commands")).toEqual([
          { state: "done" },
        ]);
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

describe("the command ledger when saving a result fails", () => {
  it.effect(
    "tries again without running the command again, and answers once the result is saved",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { wrapped } = failingWrites(db, "SET state = ?", 2);
        const ledger = yield* openCommandLedger(wrapped, logs().logger);
        const { ran, apply } = counting();

        const caller = yield* Effect.forkChild(ledger.run(entry("c1"), apply));
        yield* TestClock.adjust("50 millis");
        expect(caller.pollUnsafe()).toBeUndefined();
        expect(db.all("SELECT state FROM commands")).toEqual([
          { state: "running" },
        ]);
        yield* TestClock.adjust("10 seconds");

        expect(yield* Fiber.join(caller)).toEqual({
          ok: true,
          result: { turn: "t1" },
        });
        expect(ran.count).toBe(1);
        expect(db.all("SELECT state, result FROM commands")).toEqual([
          { state: "done", result: '{"turn":"t1"}' },
        ]);
        expect(yield* ledger.run(entry("c1"), apply)).toEqual({
          ok: true,
          result: { turn: "t1" },
        });
        expect(ran.count).toBe(1);
      }),
  );

  it.effect(
    "answers storage-failed when the result never saves, and leaves the row for the restart",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const { lines, logger } = logs();
        const { wrapped } = failingWrites(db, "SET state = ?", Infinity);
        const before = yield* Scope.make();
        const ledger = yield* openCommandLedger(wrapped, logger).pipe(
          Scope.provide(before),
        );
        const { ran, apply } = counting({ turn: "launch codes" });

        const caller = yield* Effect.forkChild(ledger.run(entry("c1"), apply));
        yield* TestClock.adjust("10 seconds");

        expect(yield* Fiber.join(caller)).toEqual({
          ok: false,
          code: "storage-failed",
        });
        expect(ran.count).toBe(1);
        expect(db.all("SELECT state, result FROM commands")).toEqual([
          { state: "running", result: null },
        ]);
        expect(JSON.stringify(lines)).not.toContain("launch codes");
        expect(yield* ledger.run(entry("c1"), apply)).toEqual({
          ok: false,
          code: "interrupted",
        });
        yield* Scope.close(before, Exit.void);

        const restarted = yield* open(db);
        expect(yield* restarted.run(entry("c1"), apply)).toEqual({
          ok: false,
          code: "interrupted",
        });
        expect(ran.count).toBe(1);
      }),
  );

  it.effect("tells a repeat that waits for the command the same answer", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const { wrapped } = failingWrites(db, "SET state = ?", Infinity);
      const ledger = yield* openCommandLedger(wrapped, logs().logger);
      const { ran, apply } = counting();

      const first = yield* Effect.forkChild(ledger.run(entry("c1"), apply));
      const second = yield* Effect.forkChild(ledger.run(entry("c1"), apply));
      yield* TestClock.adjust("10 seconds");

      expect(yield* Fiber.join(first)).toEqual({
        ok: false,
        code: "storage-failed",
      });
      expect(yield* Fiber.join(second)).toEqual({
        ok: false,
        code: "storage-failed",
      });
      expect(ran.count).toBe(1);
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

  it.effect("logs a failed hourly delete and deletes at the next one", () =>
    Effect.gen(function* () {
      const { db } = tempStore();
      const { lines, logger } = logs();
      const { wrapped, left } = failingWrites(
        db,
        "DELETE FROM commands WHERE created_at",
        0,
      );
      const ledger = yield* openCommandLedger(wrapped, logger);
      yield* ledger.run(entry("old"), counting().apply);
      left.count = 1;

      yield* TestClock.adjust(Duration.hours(2));
      expect(left.count).toBe(0);
      expect(
        lines.filter((line) => line["msg"] === "deleting old commands failed"),
      ).toHaveLength(1);
      expect(db.all("SELECT id FROM commands")).toEqual([{ id: "old" }]);

      yield* TestClock.adjust(day);
      expect(db.all("SELECT id FROM commands")).toEqual([]);
    }),
  );

  it.effect(
    "deletes old rows every hour while the server runs, and keeps a running row until it is 24 hours old",
    () =>
      Effect.gen(function* () {
        const { db } = tempStore();
        const ledger = yield* open(db);
        yield* Effect.forkChild(ledger.run(entry("slow"), Effect.never));
        yield* ledger.run(entry("done"), counting().apply);
        yield* Effect.yieldNow;

        yield* TestClock.adjust(day - Duration.toMillis(Duration.hours(1)));
        expect(db.all("SELECT id FROM commands ORDER BY id")).toEqual([
          { id: "done" },
          { id: "slow" },
        ]);

        yield* TestClock.adjust(Duration.hours(1));
        expect(db.all("SELECT id FROM commands ORDER BY id")).toEqual([]);
      }),
  );
});
