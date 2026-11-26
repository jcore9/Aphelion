import {
  sessionRef,
  turnId,
  type AdapterContext,
  type BotAdapter,
} from "@aphelion/plugin-sdk";
import {
  fakeAdapter,
  type FakeAdapter,
  type FakeScript,
} from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { describe } from "vitest";
import { createLogger } from "../log";
import type { RestartPolicy } from "../plugins/lifecycle";
import { memoryLinkPair, type Framing } from "../plugins/link";
import {
  BotManager,
  botManagerLayer,
  BotRunnerLink,
  resumeFailed,
  type BotEvent,
  type BotState,
} from "./manager";
import { runBotRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";
import { memorySessionRefs, SessionRefs } from "./session-refs";
import { fakeBotProcesses, type FakeBot } from "./test-fixture";

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

const policy: RestartPolicy = {
  launchMs: 5_000,
  handshakeMs: 5_000,
  graceMs: 2_000,
  firstRetryMs: 20,
  maxCrashes: 2,
  stableMs: 60_000,
};

const folder = "/var/lib/aphelion-bots/chief";

const system = (
  bot: FakeBot,
  setup: (
    refs: Context.Service.Shape<typeof SessionRefs>,
  ) => Effect.Effect<void> = () => Effect.void,
  provider = "fake",
) =>
  Effect.gen(function* () {
    const fake = fakeBotProcesses({ chief: bot });
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger({
      write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    });
    const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
      framing(runnerReplySchema),
      framing(runnerRequestSchema),
    );
    const runnerScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(runnerScope, Exit.void));
    yield* runBotRunner(b, {
      home: "/var/lib/aphelion-bots",
      shutdownGrace: "200 millis",
      writeDeadline: "1 second",
      logger,
    }).pipe(
      Effect.provide(fake.layer),
      Scope.provide(runnerScope),
      Effect.forkIn(runnerScope),
    );
    const services = yield* Layer.build(
      botManagerLayer({
        bots: [{ name: "chief", provider, folder }],
        logger,
        policy,
        adapters: { fake: "/adapters/fake/adapter.js" },
      }).pipe(
        Layer.provideMerge(memorySessionRefs),
        Layer.provide(Layer.succeed(BotRunnerLink, a)),
      ),
    );
    const refs = Context.get(services, SessionRefs);
    yield* setup(refs);
    const manager = Context.get(services, BotManager);
    const seen: BotEvent[] = [];
    const watching = yield* manager.events.pipe(
      Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
      Effect.forkScoped,
    );
    yield* Effect.sleep("10 millis");
    const reach = (state: BotState["state"]) =>
      manager
        .waitFor("chief", (now) => now.state === state)
        .pipe(Effect.timeout("5 seconds"), Effect.orDie);
    return { fake, logs, manager, refs, seen, reach, watching };
  });

const recording = (script: FakeScript) => {
  const made: FakeAdapter[] = [];
  const bot: FakeBot = {
    adapter: () => {
      const adapter = fakeAdapter(script);
      made.push(adapter);
      return adapter;
    },
  };
  return { bot, made };
};

const sessionTurn: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("s-1") } },
  { emit: { type: "text.delta", text: "done" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

const t = (id: string) => turnId.parse(id);

describe("the bot manager", () => {
  it.live(
    "starts a bot, runs a turn, publishes its events, saves its session, and stops it",
    () =>
      Effect.gen(function* () {
        const chief = recording([sessionTurn]);
        const { manager, refs, seen, reach } = yield* system(chief.bot);
        expect(yield* manager.start("chief")).toBe("starting");
        yield* reach("running");
        expect(yield* manager.startTurn("chief", t("t1"), "hi")).toBe(
          "accepted",
        );
        yield* reach("running");
        expect(
          seen.map(({ bot, envelope }) => [bot, envelope.event.type]),
        ).toEqual([
          ["chief", "session"],
          ["chief", "text.delta"],
          ["chief", "turn.end"],
        ]);
        expect(yield* refs.get("chief")).toEqual({ ref: "s-1", folder });
        yield* manager.stop("chief");
        expect(yield* manager.status("chief")).toEqual({ state: "stopped" });
      }).pipe(Effect.scoped),
  );

  it.live(
    "shows a turn while it runs, and refuses a second turn or one for a stopped bot",
    () =>
      Effect.gen(function* () {
        const chief = recording([[{ waitForAbort: true }]]);
        const { manager, reach } = yield* system(chief.bot);
        expect(yield* manager.startTurn("chief", t("t0"), "hi")).toBe(
          "not-running",
        );
        yield* manager.start("chief");
        yield* reach("running");
        expect(yield* manager.startTurn("chief", t("t1"), "hi")).toBe(
          "accepted",
        );
        expect(yield* manager.status("chief")).toEqual({
          state: "in turn",
          turn: "t1",
        });
        expect(yield* manager.startTurn("chief", t("t1"), "hi")).toBe(
          "accepted",
        );
        expect(yield* manager.startTurn("chief", t("t2"), "hi")).toBe("busy");
        expect(
          yield* manager.startTurn(
            "chief",
            t("t3"),
            "a".repeat(256 * 1024 + 1),
          ),
        ).toBe("too-long");
        yield* manager.cancelTurn("chief", t("t1"));
        yield* reach("running");
      }).pipe(Effect.scoped),
  );

  it.live(
    "restarts a crashed bot after the backoff and resumes its saved session, after repairing the cut-off turn",
    () =>
      Effect.gen(function* () {
        const chief = recording([
          [
            { emit: { type: "session", ref: sessionRef.parse("s-7") } },
            { hang: true },
          ],
        ]);
        const { fake, manager, seen, reach } = yield* system(chief.bot);
        yield* manager.start("chief");
        yield* reach("running");
        yield* manager.startTurn("chief", t("t1"), "work");
        yield* reach("in turn");
        fake.latest("chief")?.crash();
        yield* reach("crashed");
        yield* reach("running");
        expect(chief.made.map((made) => made.contexts[0]?.resume)).toEqual([
          null,
          "s-7",
        ]);
        expect(
          seen.map(({ run, envelope }) => [run, envelope.event.type]),
        ).toEqual([
          [1, "session"],
          [1, "error"],
          [1, "turn.end"],
        ]);
      }).pipe(Effect.scoped),
  );

  it.live("gives up on a bot that keeps crashing, and logs it", () =>
    Effect.gen(function* () {
      const { fake, logs, manager, reach } = yield* system({
        adapter: () => fakeAdapter([]),
      });
      yield* manager.start("chief");
      for (let crash = 0; crash <= policy.maxCrashes; crash++) {
        yield* reach("running");
        fake.latest("chief")?.crash();
        yield* reach(crash < policy.maxCrashes ? "crashed" : "given up");
      }
      expect(fake.runs).toHaveLength(policy.maxCrashes + 1);
      expect(logs.map((log) => log["msg"])).toContain(
        "the bot crashed too often, so it stays stopped",
      );
      yield* Effect.sleep("100 millis");
      expect(fake.runs).toHaveLength(policy.maxCrashes + 1);
    }).pipe(Effect.scoped),
  );

  it.live(
    "starts a new session at once when the saved one can't be resumed, and forgets the saved one",
    () =>
      Effect.gen(function* () {
        const contexts: AdapterContext[] = [];
        const picky: BotAdapter = {
          provider: "fake",
          open: (context) => {
            contexts.push(context);
            if (context.resume !== null) {
              throw new Error("no such session");
            }
            return fakeAdapter([]).open(context);
          },
        };
        const { logs, manager, refs, reach } = yield* system(
          { adapter: () => picky },
          (saved) =>
            saved.set("chief", { ref: sessionRef.parse("s-old"), folder }),
        );
        yield* manager.start("chief");
        yield* reach("running");
        expect(contexts.map((context) => context.resume)).toEqual([
          "s-old",
          null,
        ]);
        expect(logs.map((log) => log["msg"])).toContain(resumeFailed);
        expect(logs.filter((log) => log["to"] === "crashed")).toEqual([]);
        expect(yield* refs.get("chief")).toBeUndefined();
      }).pipe(Effect.scoped),
  );

  it.live("doesn't resume a session saved for another folder", () =>
    Effect.gen(function* () {
      const chief = recording([]);
      const { manager, reach } = yield* system(chief.bot, (saved) =>
        saved.set("chief", {
          ref: sessionRef.parse("s-1"),
          folder: "/var/lib/aphelion-bots/old-name",
        }),
      );
      yield* manager.start("chief");
      yield* reach("running");
      expect(chief.made[0]?.contexts[0]?.resume).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live(
    "refuses to start a bot whose provider has no adapter, and starts nothing",
    () =>
      Effect.gen(function* () {
        const { fake, logs, manager } = yield* system(
          recording([]).bot,
          () => Effect.void,
          "grok",
        );
        expect(yield* manager.start("chief")).toBe("unknown provider");
        expect(yield* manager.start("nobody")).toBe("unknown bot");
        expect(logs).toContainEqual(
          expect.objectContaining({
            msg: "no adapter in this image runs the bot's provider, so the bot won't start",
            bot: "chief",
            provider: "grok",
          }),
        );
        expect(fake.runs).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live("names the adapter bundle when the bot runner can't start it", () =>
    Effect.gen(function* () {
      const { logs, manager, reach } = yield* system({
        adapter: () => fakeAdapter([]),
        refuses: "the adapter bundle isn't there",
      });
      yield* manager.start("chief");
      yield* reach("crashed");
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: "the bot runner couldn't start the bot",
          bot: "chief",
          adapter: "/adapters/fake/adapter.js",
          reason: "the adapter bundle isn't there",
        }),
      );
    }).pipe(Effect.scoped),
  );
});
