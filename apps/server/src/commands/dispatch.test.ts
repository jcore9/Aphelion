import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandId,
  type CommandFrame,
  type CommandName,
  type ServerFrame,
} from "@aphelion/protocol";
import { sessionRef } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, onTestFinished } from "vitest";
import type { BotCommands } from "./dispatch";
import { dispatch, failureMessages } from "./dispatch";
import { createAdmission, type Admission } from "./admission";
import { openCommandLedger } from "./ledger";
import { deviceId } from "../devices";
import { eventFrame, openEventStore, type NewEvent } from "../history";
import { createLogger } from "../log";
import { openStore, readServerId } from "../store";
import type { StartedTurn, TurnOutcome } from "../bots/manager";

const laptop = deviceId.parse("0123456789abcdef");
const turn = "0192f0a1-3b7d-7c5e-9a21-0d4e6f8a1b23";

const logs = () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, logger };
};

const temporaryFolder = () => {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-dispatch-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return dir;
};

interface SetupOptions {
  readonly admission?: Admission;
  readonly hold?: Effect.Effect<void>;
  readonly dir?: string;
}

const setup = (
  outcome: TurnOutcome = "accepted",
  withBots = true,
  options: SetupOptions = {},
) =>
  Effect.gen(function* () {
    const dir = options.dir ?? temporaryFolder();
    const db = openStore(join(dir, "aphelion.db"));
    onTestFinished(() => {
      db.close();
    });
    const { lines, logger } = logs();
    const history = yield* openEventStore(db, readServerId(db), { logger });
    const ledger = yield* openCommandLedger(db, logger);
    const calls = {
      prompts: [] as { bot: string; text: string }[],
      cancels: [] as { bot: string; turn: string }[],
    };
    const bots: BotCommands = {
      startTurn: (bot, text) =>
        Effect.sync(() => {
          calls.prompts.push({ bot, text });
        }).pipe(
          Effect.andThen(options.hold ?? Effect.void),
          Effect.as({ turn, outcome } as StartedTurn),
        ),
      cancelTurn: (bot, id) =>
        Effect.sync(() => {
          calls.cancels.push({ bot, turn: id });
        }),
    };
    const context = {
      bots: withBots ? bots : undefined,
      ledger,
      admission: options.admission ?? createAdmission(),
      history,
      logger,
    };
    const send = <N extends CommandName>(
      name: N,
      payload: Extract<CommandFrame, { name: N }>["payload"],
      id = "c1",
      device = laptop,
    ) =>
      dispatch(context, device, {
        v: 1,
        type: "command",
        id: commandId.parse(id),
        name,
        payload,
      } as CommandFrame);
    return { db, history, calls, lines, send };
  });

const delta = (
  text: string,
  bot = "chief",
  turnId: string | null = "t1",
): NewEvent => ({
  bot,
  run: 1,
  turn: turnId,
  event: { type: "text.delta", text },
});

describe("bot.prompt", () => {
  it.effect("starts one turn and answers a repeat with the same turn", () =>
    Effect.gen(function* () {
      const { calls, send } = yield* setup();

      const first = yield* send("bot.prompt", { bot: "chief", text: "Hello" });
      const again = yield* send("bot.prompt", { bot: "chief", text: "Hello" });

      expect(first).toEqual({
        v: 1,
        type: "result",
        id: "c1",
        name: "bot.prompt",
        result: { turn },
      });
      expect(again).toEqual(first);
      expect(calls.prompts).toEqual([{ bot: "chief", text: "Hello" }]);
    }),
  );

  it.effect(
    "answers a repeat after a server restart with the same turn and starts no second one",
    () =>
      Effect.gen(function* () {
        const dir = temporaryFolder();
        const before = yield* setup("accepted", true, { dir });
        const first = yield* before.send("bot.prompt", {
          bot: "chief",
          text: "Hello",
        });
        before.db.close();

        const after = yield* setup("accepted", true, { dir });
        const again = yield* after.send("bot.prompt", {
          bot: "chief",
          text: "Hello",
        });

        expect(again).toEqual(first);
        expect(before.calls.prompts).toHaveLength(1);
        expect(after.calls.prompts).toEqual([]);
      }),
  );

  it.effect(
    "answers internal, not a broken frame, when the saved result no longer fits",
    () =>
      Effect.gen(function* () {
        const { db, lines, send } = yield* setup();
        yield* send("bot.prompt", { bot: "chief", text: "Hello" });
        db.run("UPDATE commands SET result = '{\"turn\":5}'");

        const again = yield* send("bot.prompt", {
          bot: "chief",
          text: "Hello",
        });

        expect(again).toEqual({
          v: 1,
          type: "error",
          id: "c1",
          code: "internal",
          message: failureMessages.internal,
        });
        expect(JSON.stringify(lines)).not.toContain("Hello");
      }),
  );

  it.effect("gives two ids two turns", () =>
    Effect.gen(function* () {
      const { calls, send } = yield* setup();

      yield* send("bot.prompt", { bot: "chief", text: "Hello" }, "c1");
      yield* send("bot.prompt", { bot: "chief", text: "Hello" }, "c2");

      expect(calls.prompts).toHaveLength(2);
    }),
  );

  it.effect.each([
    { outcome: "not-running", code: "bot-not-running" },
    { outcome: "busy", code: "bot-busy" },
    { outcome: "too-long", code: "prompt-too-long" },
    { outcome: "ended", code: "prompt-refused" },
    { outcome: "refused", code: "prompt-refused" },
    { outcome: "no-answer", code: "bot-not-responding" },
  ] as const)(
    "answers a $outcome turn with $code and fixed text, also on a repeat",
    ({ outcome, code }) =>
      Effect.gen(function* () {
        const { calls, send } = yield* setup(outcome);

        const first = yield* send("bot.prompt", {
          bot: "chief",
          text: "secret plans",
        });
        const again = yield* send("bot.prompt", {
          bot: "chief",
          text: "secret plans",
        });

        expect(first).toEqual({
          v: 1,
          type: "error",
          id: "c1",
          code,
          message: failureMessages[code],
        });
        expect(again).toEqual(first);
        expect(calls.prompts).toHaveLength(1);
      }),
  );

  it.effect("answers bot-not-running when the server runs no bots", () =>
    Effect.gen(function* () {
      const { send } = yield* setup("accepted", false);

      expect(
        yield* send("bot.prompt", { bot: "chief", text: "Hello" }),
      ).toMatchObject({ type: "error", code: "bot-not-running" });
    }),
  );

  it.effect("never writes the prompt to a log line", () =>
    Effect.gen(function* () {
      const { lines, send } = yield* setup("refused");

      yield* send("bot.prompt", { bot: "chief", text: "secret plans" });

      expect(JSON.stringify(lines)).not.toContain("secret plans");
    }),
  );

  it.effect("keeps one device's ids apart from another's", () =>
    Effect.gen(function* () {
      const { calls, send } = yield* setup();

      yield* send("bot.prompt", { bot: "chief", text: "a" }, "c1", laptop);
      yield* send(
        "bot.prompt",
        { bot: "chief", text: "b" },
        "c1",
        deviceId.parse("fedcba9876543210"),
      );

      expect(calls.prompts.map(({ text }) => text)).toEqual(["a", "b"]);
    }),
  );
});

describe("bot.cancel", () => {
  it.effect("cancels the turn once, even when the command repeats", () =>
    Effect.gen(function* () {
      const { calls, send } = yield* setup();

      const first = yield* send("bot.cancel", { bot: "chief", turn });
      const again = yield* send("bot.cancel", { bot: "chief", turn });

      expect(first).toEqual({
        v: 1,
        type: "result",
        id: "c1",
        name: "bot.cancel",
        result: {},
      });
      expect(again).toEqual(first);
      expect(calls.cancels).toEqual([{ bot: "chief", turn }]);
    }),
  );

  it.effect("succeeds, doing nothing, when the server runs no bots", () =>
    Effect.gen(function* () {
      const { send } = yield* setup("accepted", false);

      expect(yield* send("bot.cancel", { bot: "chief", turn })).toMatchObject({
        type: "result",
        result: {},
      });
    }),
  );
});

describe("ping", () => {
  it.effect("answers with an empty result and keeps no row", () =>
    Effect.gen(function* () {
      const { db, send } = yield* setup();

      expect(yield* send("ping", {})).toEqual({
        v: 1,
        type: "result",
        id: "c1",
        name: "ping",
        result: {},
      });
      expect(db.all("SELECT * FROM commands")).toEqual([]);
    }),
  );
});

const page = (frame: ServerFrame) => {
  if (frame.type !== "result" || frame.name !== "history.read") {
    throw new Error("not a history page");
  }
  return frame.result;
};

describe("history.read", () => {
  const fill = (setupResult: Effect.Success<ReturnType<typeof setup>>) =>
    Effect.gen(function* () {
      const { history } = setupResult;
      yield* history.openTurn("chief", "t1");
      yield* history.openTurn("scout", "t2");
      const session: NewEvent["event"] = {
        type: "session",
        ref: sessionRef.parse("vendor-secret-ref"),
      };
      for (const event of [
        delta("a"),
        delta("x", "scout", "t2"),
        { ...delta("b"), event: session },
        delta("c"),
        delta("d"),
      ]) {
        yield* history.record(event);
      }
      yield* TestClock.adjust("50 millis");
    });

  it.effect(
    "returns the bot's events as replay would send them, without the session ref",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* fill(env);

        const result = page(
          yield* env.send("history.read", { bot: "chief", limit: 10 }),
        );

        expect(result.events.map(({ seq }) => seq)).toEqual([1, 4, 5]);
        expect(result.events).toEqual(
          env.history
            .readBot("chief", 0, 10)
            .flatMap((saved) => eventFrame(saved) ?? [])
            .map(({ seq, payload }) => ({ seq, payload })),
        );
        expect(JSON.stringify(result)).not.toContain("vendor-secret-ref");
        expect(result).toMatchObject({ next: 5, more: false });
      }),
  );

  it.effect(
    "pages with next and more, and counts the skipped session event in next",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* fill(env);

        const first = page(
          yield* env.send("history.read", { bot: "chief", limit: 2 }),
        );
        const second = page(
          yield* env.send("history.read", {
            bot: "chief",
            after: first.next,
            limit: 2,
          }),
        );

        expect(first.events.map(({ seq }) => seq)).toEqual([1]);
        expect(first).toMatchObject({ next: 3, more: true });
        expect(second.events.map(({ seq }) => seq)).toEqual([4, 5]);
        expect(second).toMatchObject({ next: 5, more: false });
      }),
  );

  it.effect("returns an empty page for a bot with no events", () =>
    Effect.gen(function* () {
      const env = yield* setup();

      expect(
        page(yield* env.send("history.read", { bot: "nobody", limit: 5 })),
      ).toEqual({ events: [], next: 0, more: false });
    }),
  );

  it.effect(
    "sees events saved after an earlier read with the same id, and keeps no row",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.history.openTurn("chief", "t1");
        yield* env.history.record(delta("a"));
        yield* TestClock.adjust("50 millis");
        yield* env.send("history.read", { bot: "chief", limit: 10 });
        yield* env.history.record(delta("b"));
        yield* TestClock.adjust("50 millis");

        const later = page(
          yield* env.send("history.read", { bot: "chief", limit: 10 }),
        );

        expect(later.events).toHaveLength(2);
        expect(env.db.all("SELECT * FROM commands")).toEqual([]);
      }),
  );

  it.effect(
    "answers internal, with fixed text, when a saved event can't be read",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.history.openTurn("chief", "t1");
        yield* env.history.record(delta("private words"));
        yield* TestClock.adjust("50 millis");
        env.db.run("UPDATE events SET format = 9");

        const answer = yield* env.send("history.read", {
          bot: "chief",
          limit: 10,
        });

        expect(answer).toEqual({
          v: 1,
          type: "error",
          id: "c1",
          code: "internal",
          message: failureMessages.internal,
        });
        expect(JSON.stringify(env.lines)).not.toContain("private words");
      }),
  );
});

describe("command admission in dispatch", () => {
  it.effect(
    "refuses a command past the in-flight limit with rate-limited and claims no ledger row",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<undefined>();
        const env = yield* setup("accepted", true, {
          admission: createAdmission({ maxInFlight: 2 }),
          hold: Deferred.await(gate),
        });
        const held = [
          yield* Effect.forkChild(
            env.send("bot.prompt", { bot: "chief", text: "a" }, "a"),
          ),
          yield* Effect.forkChild(
            env.send("bot.prompt", { bot: "chief", text: "b" }, "b"),
          ),
        ];
        yield* TestClock.adjust("10 millis");

        const refused = yield* env.send(
          "bot.prompt",
          { bot: "chief", text: "c" },
          "c",
        );
        const read = yield* env.send(
          "history.read",
          { bot: "chief", limit: 1 },
          "r",
        );

        expect(refused).toEqual({
          v: 1,
          type: "error",
          id: "c",
          code: "rate-limited",
          message: failureMessages["rate-limited"],
        });
        expect(read).toMatchObject({ type: "error", code: "rate-limited" });
        expect(env.db.all("SELECT id FROM commands ORDER BY id")).toEqual([
          { id: "a" },
          { id: "b" },
        ]);
        expect(env.calls.prompts).toHaveLength(2);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.joinAll(held);
      }),
  );

  it.effect(
    "keeps a mutation's place until its result is saved, even when its dispatcher is interrupted",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<undefined>();
        const env = yield* setup("accepted", true, {
          admission: createAdmission({ maxInFlight: 1 }),
          hold: Deferred.await(gate),
        });
        const first = yield* Effect.forkChild(
          env.send("bot.prompt", { bot: "chief", text: "a" }, "a"),
        );
        yield* TestClock.adjust("10 millis");
        yield* Fiber.interrupt(first);

        const refused = yield* env.send(
          "bot.prompt",
          { bot: "chief", text: "b" },
          "b",
        );
        expect(refused).toMatchObject({ type: "error", code: "rate-limited" });
        expect(env.db.all("SELECT id, state FROM commands")).toEqual([
          { id: "a", state: "running" },
        ]);

        yield* Deferred.succeed(gate, undefined);
        yield* TestClock.adjust("10 millis");
        expect(env.db.all("SELECT id, state FROM commands")).toEqual([
          { id: "a", state: "done" },
        ]);
        const next = yield* env.send(
          "bot.prompt",
          { bot: "chief", text: "c" },
          "c",
        );
        expect(next.type).toBe("result");
      }),
  );

  it.effect(
    "refuses the 61st mutation of a minute with rate-limited and claims no ledger row, but still reads",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        for (let sent = 0; sent < 60; sent += 1) {
          const answer = yield* env.send(
            "bot.prompt",
            { bot: "chief", text: "hi" },
            `c${String(sent)}`,
          );
          expect(answer.type).toBe("result");
        }

        const refused = yield* env.send(
          "bot.cancel",
          { bot: "chief", turn },
          "x1",
        );
        const read = yield* env.send(
          "history.read",
          { bot: "chief", limit: 1 },
          "r1",
        );

        expect(refused).toMatchObject({
          type: "error",
          id: "x1",
          code: "rate-limited",
        });
        expect(read.type).toBe("result");
        expect(env.db.all("SELECT COUNT(*) AS rows FROM commands")).toEqual([
          { rows: 60 },
        ]);
        expect(env.calls.cancels).toEqual([]);

        yield* TestClock.adjust("1 minute");
        expect(
          (yield* env.send("bot.cancel", { bot: "chief", turn }, "x2")).type,
        ).toBe("result");
      }),
  );

  it.effect("answers ping without counting it", () =>
    Effect.gen(function* () {
      const env = yield* setup("accepted", true, {
        admission: createAdmission({ maxInFlight: 1, perMinute: 1 }),
      });
      for (let sent = 0; sent < 5; sent += 1) {
        expect((yield* env.send("ping", {}, `p${String(sent)}`)).type).toBe(
          "result",
        );
      }
    }),
  );
});

describe("history.read page size", () => {
  const bigDelta = (index: number): NewEvent =>
    delta(`${String(index).padStart(2, "0")}${"x".repeat(16 * 1024 - 2)}`);

  it.effect(
    "stops a page at 256 KiB of encoded events and pages on from next",
    () =>
      Effect.gen(function* () {
        const env = yield* setup();
        yield* env.history.openTurn("chief", "t1");
        for (let index = 0; index < 40; index += 1) {
          yield* env.history.record(bigDelta(index));
        }
        yield* TestClock.adjust("50 millis");
        yield* env.history.flush;

        const seen: number[] = [];
        let after = 0;
        let pages = 0;
        for (;;) {
          const result = page(
            yield* env.send(
              "history.read",
              { bot: "chief", after, limit: 500 },
              `r${String(pages)}`,
            ),
          );
          expect(
            Buffer.byteLength(JSON.stringify(result.events)),
          ).toBeLessThanOrEqual(256 * 1024);
          expect(result.events.length).toBeGreaterThan(0);
          seen.push(...result.events.map(({ seq }) => seq));
          pages += 1;
          if (!result.more) break;
          expect(result.next).toBe(result.events.at(-1)?.seq);
          after = result.next;
        }

        expect(pages).toBeGreaterThan(1);
        expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      }),
  );
});
