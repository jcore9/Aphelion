import {
  adapterMethods,
  maxPluginLineBytes,
  request,
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
import { commandId, version } from "@aphelion/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Scope,
  Stream,
} from "effect";
import { describe } from "vitest";
import { createAdmission, dispatch, openCommandLedger } from "../commands";
import { deviceId } from "../devices";
import { openEventStore, runBots } from "../history";
import { createLogger } from "../log";
import type { RestartPolicy } from "../plugins/lifecycle";
import { pipeLink } from "../plugins/link";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";
import { openStore, readServerId } from "../store";
import {
  BotManager,
  botManagerLayer,
  BotRunnerLink,
  resumeFailed,
  runnerChannelFailedMessage,
  runnerNotices,
  type BotEvent,
  type BotManagerOptions,
  type BotState,
  type TurnLedger,
} from "./manager";
import { SessionRefs } from "./session-refs";
import { sqliteSessionRefs } from "./sqlite-session-refs";
import {
  fakeBotProcesses,
  fakeRunnerLink,
  memorySessionRefs,
  type FakeBot,
} from "./test-fixture";

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
  sessionLayer: Layer.Layer<SessionRefs> = memorySessionRefs,
  turns?: TurnLedger,
  shape: (
    link: Context.Service.Shape<typeof BotRunnerLink>,
  ) => Context.Service.Shape<typeof BotRunnerLink> = (link) => link,
  more: Partial<BotManagerOptions> = {},
) =>
  Effect.gen(function* () {
    const fake = fakeBotProcesses({ chief: bot });
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger({
      write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
    });
    const link = yield* fakeRunnerLink(fake, logger);
    const services = yield* Layer.build(
      botManagerLayer({
        bots: [{ name: "chief", provider, folder }],
        logger,
        policy,
        adapters: { fake: "/adapters/fake/adapter.js" },
        ...(turns === undefined ? {} : { turns }),
        ...more,
      }).pipe(
        Layer.provideMerge(sessionLayer),
        Layer.provide(Layer.succeed(BotRunnerLink, shape(link))),
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

const uuidV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const silentStarts = (
  swallow = Number.POSITIVE_INFINITY,
  gate?: Deferred.Deferred<undefined>,
) =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
    const sent: RunnerRequest[] = [];
    let starts = 0;
    const shape = (link: Context.Service.Shape<typeof BotRunnerLink>) => {
      Effect.runFork(
        Queue.take(link.incoming).pipe(
          Effect.flatMap((reply) => Queue.offer(incoming, reply)),
          Effect.forever,
          Effect.ignore,
        ),
      );
      return {
        incoming,
        send: (message: RunnerRequest) => {
          sent.push(message);
          if (message.type !== "turn.start") return link.send(message);
          starts += 1;
          const swallowed = starts <= swallow;
          const held = gate === undefined ? Effect.void : Deferred.await(gate);
          return held.pipe(
            Effect.andThen(swallowed ? Effect.void : link.send(message)),
          );
        },
      };
    };
    return { incoming, sent, shape };
  });

const eventually = (until: () => boolean) =>
  Effect.gen(function* () {
    while (!until()) yield* Effect.sleep("10 millis");
  }).pipe(Effect.timeout("5 seconds"), Effect.orDie);

const ledgerCalls = () => {
  const calls: string[] = [];
  const turns: TurnLedger = {
    open: (_bot, turn) =>
      Effect.sync(() => {
        calls.push(`open ${turn}`);
        return true;
      }),
    end: (turn, reason) =>
      Effect.sync(() => {
        calls.push(`end ${turn} ${reason}`);
      }),
  };
  return { calls, turns };
};

const controlCharsThatFit = () => {
  const empty = JSON.stringify(
    request(Number.MAX_SAFE_INTEGER, adapterMethods.turnStart, {
      turn: "0192f0a1-3b7d-7c5e-9a21-0d4e6f8a1b23",
      text: "",
    }),
  );
  return Math.floor(
    (maxPluginLineBytes - new TextEncoder().encode(empty).byteLength) / 6,
  );
};

describe("a prompt's encoded line to the runner", () => {
  it.live("accepts a prompt of escapes whose line is just under 1 MiB", () =>
    Effect.gen(function* () {
      const { manager, reach } = yield* system(recording([sessionTurn]).bot);
      yield* manager.start("chief");
      yield* reach("running");

      const started = yield* manager.startTurn(
        "chief",
        "\u0001".repeat(controlCharsThatFit()),
      );

      expect(started.outcome).toBe("accepted");
    }).pipe(Effect.scoped),
  );

  it.live(
    "answers too-long, and sends nothing, when the line is over 1 MiB",
    () =>
      Effect.gen(function* () {
        const { calls, turns } = ledgerCalls();
        const { sent, shape } = yield* silentStarts();
        const { manager, reach } = yield* system(
          recording([sessionTurn]).bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          turns,
          shape,
        );
        yield* manager.start("chief");
        yield* reach("running");

        const started = yield* manager.startTurn(
          "chief",
          "\u0001".repeat(controlCharsThatFit() + 1),
        );

        expect(started.outcome).toBe("too-long");
        expect(sent.filter(({ type }) => type === "turn.start")).toEqual([]);
        expect(calls).toEqual([]);
      }).pipe(Effect.scoped),
  );
});

describe("a turn start that the adapter hasn't answered", () => {
  it.live("makes another prompt wait as busy, not start a second turn", () =>
    Effect.gen(function* () {
      const { calls, turns } = ledgerCalls();
      const { sent, shape } = yield* silentStarts();
      const { manager, reach } = yield* system(
        recording([sessionTurn]).bot,
        () => Effect.void,
        "fake",
        memorySessionRefs,
        turns,
        shape,
      );
      yield* manager.start("chief");
      yield* reach("running");
      const first = yield* manager
        .startTurn("chief", "first")
        .pipe(Effect.forkScoped);
      yield* Effect.sleep("30 millis");

      const second = yield* manager.startTurn("chief", "second");

      expect(second.outcome).toBe("busy");
      expect(sent.filter(({ type }) => type === "turn.start")).toHaveLength(1);
      expect(calls).toEqual([
        expect.stringMatching(/^open /),
        `open ${second.turn}`,
        `end ${second.turn} refused`,
      ]);
      yield* Fiber.interrupt(first);
    }).pipe(Effect.scoped),
  );

  it.live(
    "ends the turn as refused at the deadline, keeps the bot busy while its run restarts with resume, then takes the next prompt",
    () =>
      Effect.gen(function* () {
        const { calls, turns } = ledgerCalls();
        const { sent, shape } = yield* silentStarts(1);
        const { manager, reach } = yield* system(
          recording([sessionTurn]).bot,
          (refs) =>
            refs.set("chief", {
              ref: sessionRef.parse("s-old"),
              folder,
              provider: "fake",
            }),
          "fake",
          memorySessionRefs,
          turns,
          shape,
          { turnAcceptDeadlineMs: 60 },
        );
        yield* manager.start("chief");
        yield* reach("running");

        const first = yield* manager.startTurn("chief", "first");
        const during = yield* manager.startTurn("chief", "second");

        expect(first.outcome).toBe("no-answer");
        expect(during.outcome).toBe("busy");
        expect(calls.slice(0, 2)).toEqual([
          `open ${first.turn}`,
          `end ${first.turn} refused`,
        ]);

        yield* eventually(() =>
          sent.some(({ type, run }) => type === "start" && run === 2),
        );
        expect(sent.filter(({ type }) => type === "stop")).toEqual([
          { type: "stop", bot: "chief", run: 1 },
        ]);
        expect(
          sent.find(({ type, run }) => type === "start" && run === 2),
        ).toMatchObject({
          resume: "s-old",
        });
        yield* reach("running");
        const next = yield* manager.startTurn("chief", "third");
        expect(next.outcome).toBe("accepted");
        expect(sent.filter(({ type }) => type === "turn.start")).toHaveLength(
          2,
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "answers at the deadline even when the runner write is stuck, and refuses new prompts as busy",
    () =>
      Effect.gen(function* () {
        const { turns } = ledgerCalls();
        const gate = yield* Deferred.make<undefined>();
        const { sent, shape } = yield* silentStarts(1, gate);
        const { manager, reach } = yield* system(
          recording([sessionTurn]).bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          turns,
          shape,
          { turnAcceptDeadlineMs: 60 },
        );
        yield* manager.start("chief");
        yield* reach("running");

        const first = yield* manager
          .startTurn("chief", "first")
          .pipe(Effect.timeout("1 second"), Effect.orDie);
        const during = yield* manager
          .startTurn("chief", "second")
          .pipe(Effect.timeout("1 second"), Effect.orDie);

        expect(first.outcome).toBe("no-answer");
        expect(during.outcome).toBe("busy");

        yield* Deferred.succeed(gate, undefined);
        yield* eventually(() =>
          sent.some(({ type, run }) => type === "start" && run === 2),
        );
        yield* reach("running");
        expect((yield* manager.startTurn("chief", "third")).outcome).toBe(
          "accepted",
        );
      }).pipe(Effect.scoped),
  );

  it.live(
    "ignores an accept from the run it restarted, and tells the runner nothing",
    () =>
      Effect.gen(function* () {
        const { turns } = ledgerCalls();
        const { incoming, sent, shape } = yield* silentStarts(1);
        const { manager, reach } = yield* system(
          recording([sessionTurn]).bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          turns,
          shape,
          { turnAcceptDeadlineMs: 40 },
        );
        yield* manager.start("chief");
        yield* reach("running");
        const late = yield* manager.startTurn("chief", "slow");
        expect(late.outcome).toBe("no-answer");
        yield* eventually(() =>
          sent.some(({ type, run }) => type === "start" && run === 2),
        );
        yield* reach("running");

        yield* Queue.offer(incoming, {
          type: "turn.accepted",
          bot: "chief",
          run: 1,
          turn: late.turn,
        });
        yield* Effect.sleep("30 millis");

        expect(sent.filter(({ type }) => type === "turn.cancel")).toEqual([]);
        expect(yield* manager.status("chief")).toEqual({ state: "running" });
      }).pipe(Effect.scoped),
  );

  it.live(
    "never sends a queued turn that expired before dispatch, even after spawned and started",
    () =>
      Effect.gen(function* () {
        const { calls, turns } = ledgerCalls();
        const startGate = yield* Deferred.make<undefined>();
        const startReached = yield* Deferred.make<undefined>();
        const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
        const sent: RunnerRequest[] = [];
        const logs: Record<string, unknown>[] = [];
        const logger = createLogger({
          write: (line) =>
            logs.push(JSON.parse(line) as Record<string, unknown>),
        });
        const link: Context.Service.Shape<typeof BotRunnerLink> = {
          incoming,
          send: (message) =>
            Effect.gen(function* () {
              sent.push(message);
              if (message.type === "start") {
                yield* Deferred.succeed(startReached, undefined);
                yield* Deferred.await(startGate);
                return;
              }
              if (message.type === "stop") {
                yield* Queue.offer(incoming, {
                  type: "stopped",
                  bot: message.bot,
                  run: message.run,
                });
                return;
              }
              if (message.type === "turn.start") {
                yield* Queue.offer(incoming, {
                  type: "turn.accepted",
                  bot: message.bot,
                  run: message.run,
                  turn: message.turn,
                });
              }
            }),
        };
        const services = yield* Layer.build(
          botManagerLayer({
            bots: [{ name: "chief", provider: "fake", folder }],
            logger,
            policy,
            adapters: { fake: "/adapters/fake/adapter.js" },
            turns,
            turnAcceptDeadlineMs: 40,
          }).pipe(
            Layer.provideMerge(memorySessionRefs),
            Layer.provide(Layer.succeed(BotRunnerLink, link)),
          ),
        );
        const manager = Context.get(services, BotManager);

        yield* manager.start("chief");
        yield* Deferred.await(startReached);
        yield* Queue.offer(incoming, {
          type: "spawned",
          bot: "chief",
          run: 1,
        });
        yield* Queue.offer(incoming, {
          type: "started",
          bot: "chief",
          run: 1,
        });
        yield* Effect.sleep("15 millis");

        const expired = yield* manager.startTurn("chief", "expired prompt");
        expect(expired.outcome).toBe("no-answer");
        expect(calls).toEqual([
          `open ${expired.turn}`,
          `end ${expired.turn} refused`,
        ]);

        yield* Deferred.succeed(startGate, undefined);
        yield* manager
          .waitFor("chief", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);
        yield* Effect.sleep("40 millis");

        expect(sent.filter(({ type }) => type === "turn.start")).toEqual([]);
        expect(sent.filter(({ type }) => type === "stop")).toEqual([]);
        expect(sent.filter(({ type }) => type === "start")).toHaveLength(1);

        const fresh = yield* manager.startTurn("chief", "fresh prompt");
        expect(fresh.outcome).toBe("accepted");
        expect(sent.filter(({ type }) => type === "turn.start")).toEqual([
          {
            type: "turn.start",
            bot: "chief",
            run: 1,
            turn: fresh.turn,
            text: "fresh prompt",
          },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "bounds a stuck runner write, tears down the channel, ends pending turns, and lets another bot succeed after recovery",
    () =>
      Effect.gen(function* () {
        const { calls, turns } = ledgerCalls();
        const logs: Record<string, unknown>[] = [];
        const logger = createLogger({
          write: (line) =>
            logs.push(JSON.parse(line) as Record<string, unknown>),
        });
        let blockWrites = false;
        let tornDown = false;
        let channelFailed = 0;
        const failedSignal = yield* Deferred.make<undefined>();
        const encoder = new TextEncoder();
        let repliesController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        const repliesStream = new ReadableStream<Uint8Array>({
          start(controller) {
            repliesController = controller;
          },
        });
        const emitReply = (reply: RunnerReply) => {
          if (!tornDown) {
            repliesController?.enqueue(
              encoder.encode(`${JSON.stringify(reply)}\n`),
            );
          }
        };
        const baseLink = yield* pipeLink(
          repliesStream,
          (line) => {
            if (blockWrites) return new Promise(() => undefined);
            const message = JSON.parse(line) as RunnerRequest;
            if (message.type === "start") {
              emitReply({
                type: "spawned",
                bot: message.bot,
                run: message.run,
              });
              emitReply({
                type: "started",
                bot: message.bot,
                run: message.run,
              });
            }
            return Promise.resolve();
          },
          {
            schema: runnerReplySchema,
            maxBytes: maxFrameBytes,
            onDrop: () => Effect.void,
          },
          runnerRequestSchema,
        );
        const gatedLink = {
          incoming: baseLink.incoming,
          send: baseLink.send,
          close: Effect.sync(() => {
            if (tornDown) return;
            tornDown = true;
            repliesController?.close();
          }),
        };

        const bots = [
          {
            name: "alpha",
            provider: "fake",
            folder: "/var/lib/aphelion-bots/alpha",
          },
          {
            name: "beta",
            provider: "fake",
            folder: "/var/lib/aphelion-bots/beta",
          },
        ];
        const services = yield* Layer.build(
          botManagerLayer({
            bots,
            logger,
            policy,
            adapters: { fake: "/adapters/fake/adapter.js" },
            turns,
            turnAcceptDeadlineMs: 5_000,
            writeDeadlineMs: 60,
            onChannelFailed: () =>
              Effect.sync(() => {
                channelFailed += 1;
              }).pipe(
                Effect.andThen(
                  Deferred.succeed(failedSignal, undefined).pipe(Effect.asVoid),
                ),
              ),
          }).pipe(
            Layer.provideMerge(memorySessionRefs),
            Layer.provide(Layer.succeed(BotRunnerLink, gatedLink)),
          ),
        );
        const manager = Context.get(services, BotManager);
        yield* manager.start("alpha");
        yield* manager.start("beta");
        yield* manager
          .waitFor("alpha", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);
        yield* manager
          .waitFor("beta", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        blockWrites = true;
        const alphaFiber = yield* manager
          .startTurn("alpha", "stuck")
          .pipe(Effect.forkScoped);
        yield* Effect.sleep("15 millis");
        const betaFiber = yield* manager
          .startTurn("beta", "blocked")
          .pipe(Effect.forkScoped);

        const [alphaResult, betaResult] = yield* Effect.all([
          Fiber.join(alphaFiber),
          Fiber.join(betaFiber),
        ]).pipe(Effect.timeout("1 second"), Effect.orDie);
        yield* Deferred.await(failedSignal).pipe(
          Effect.timeout("1 second"),
          Effect.orDie,
        );

        expect(alphaResult.outcome).toBe("not-running");
        expect(betaResult.outcome).toBe("not-running");
        expect(tornDown).toBe(true);
        expect(channelFailed).toBe(1);
        expect(calls).toContain(`end ${alphaResult.turn} refused`);
        expect(calls).toContain(`end ${betaResult.turn} refused`);
        expect(
          logs.some(
            (entry) =>
              entry["level"] === "error" &&
              entry["msg"] === runnerChannelFailedMessage,
          ),
        ).toBe(true);
        expect(yield* manager.status("alpha")).toEqual({ state: "stopped" });
        expect(yield* manager.status("beta")).toEqual({ state: "stopped" });

        const alphaRec = recording([sessionTurn]);
        const betaRec = recording([sessionTurn]);
        const recoveredFake = fakeBotProcesses({
          alpha: alphaRec.bot,
          beta: betaRec.bot,
        });
        const recoveredLink = yield* fakeRunnerLink(recoveredFake, logger);
        const recoveredServices = yield* Layer.build(
          botManagerLayer({
            bots,
            logger,
            policy,
            adapters: { fake: "/adapters/fake/adapter.js" },
          }).pipe(
            Layer.provideMerge(memorySessionRefs),
            Layer.provide(Layer.succeed(BotRunnerLink, recoveredLink)),
          ),
        );
        const recovered = Context.get(recoveredServices, BotManager);
        yield* recovered.start("beta");
        yield* recovered
          .waitFor("beta", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        const next = yield* recovered.startTurn("beta", "after recovery");
        expect(next.outcome).toBe("accepted");
        expect(
          recoveredFake
            .latest("beta")
            ?.received.some(
              (msg) =>
                msg.method === adapterMethods.turnStart &&
                (msg.params as { text?: string } | undefined)?.text ===
                  "after recovery",
            ),
        ).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live(
    "saves a turn.end queued behind a stalled write before signalling channel failure",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "aphelion-s16-"));
        const db = openStore(join(dir, "aphelion.db"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
          }),
        );
        const logger = createLogger({ write: () => undefined });
        const encoder = new TextEncoder();
        let blockWrites = false;
        let tornDown = false;
        let repliesController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        const cancelBlocked = yield* Deferred.make<undefined>();
        const runnerFailed = yield* Deferred.make<undefined>();
        const repliesStream = new ReadableStream<Uint8Array>({
          start(controller) {
            repliesController = controller;
          },
        });
        const emitReply = (reply: RunnerReply) => {
          if (!tornDown) {
            repliesController?.enqueue(
              encoder.encode(`${JSON.stringify(reply)}\n`),
            );
          }
        };
        const dropped: string[] = [];
        const baseLink = yield* pipeLink(
          repliesStream,
          (line) => {
            const message = JSON.parse(line) as RunnerRequest;
            if (blockWrites) {
              if (message.type === "turn.cancel") {
                Deferred.doneUnsafe(cancelBlocked, Exit.succeed(undefined));
              }
              return new Promise(() => undefined);
            }
            if (message.type === "start") {
              emitReply({
                type: "spawned",
                bot: message.bot,
                run: message.run,
              });
              emitReply({
                type: "started",
                bot: message.bot,
                run: message.run,
              });
            }
            if (message.type === "turn.start") {
              emitReply({
                type: "turn.accepted",
                bot: message.bot,
                run: message.run,
                turn: message.turn,
              });
            }
            return Promise.resolve();
          },
          {
            schema: runnerReplySchema,
            maxBytes: maxFrameBytes,
            onDrop: (reason) =>
              Effect.sync(() => {
                dropped.push(reason);
              }),
          },
          runnerRequestSchema,
        );
        const gatedLink = {
          incoming: baseLink.incoming,
          send: baseLink.send,
          close: Effect.sync(() => {
            if (tornDown) return;
            tornDown = true;
            repliesController?.close();
          }),
        };
        const services = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(BotRunnerLink, gatedLink),
            memorySessionRefs,
          ),
        );
        const app = yield* Scope.make();
        const bots = yield* Effect.gen(function* () {
          const history = yield* openEventStore(db, readServerId(db), {
            logger,
          });
          return yield* runBots(
            {
              bots: [{ name: "chief", provider: "fake", folder }],
              logger,
              policy,
              adapters: { fake: "/adapters/fake/adapter.js" },
              writeDeadlineMs: 60,
              onChannelFailed: () =>
                Deferred.succeed(runnerFailed, undefined).pipe(Effect.asVoid),
            },
            history,
          ).pipe(Effect.provideContext(services));
        }).pipe(Scope.provide(app));

        yield* bots
          .waitFor("chief", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);
        const started = yield* bots.startTurn("chief", "work");
        expect(started.outcome).toBe("accepted");
        yield* bots
          .waitFor("chief", (state) => state.state === "in turn")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        blockWrites = true;
        yield* bots.cancelTurn("chief", started.turn);
        yield* Deferred.await(cancelBlocked).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        emitReply({
          type: "event",
          bot: "chief",
          run: 1,
          envelope: {
            seq: 1,
            turn: started.turn,
            event: { type: "text.delta", text: "done" },
          },
        });
        emitReply({
          type: "event",
          bot: "chief",
          run: 1,
          envelope: {
            seq: 2,
            turn: started.turn,
            event: { type: "turn.end", reason: "completed" },
          },
        });

        yield* Deferred.await(runnerFailed).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        yield* Scope.close(app, Exit.void);

        expect(dropped).toEqual([]);

        expect(
          db
            .all("SELECT turn, kind FROM events ORDER BY position")
            .map((row) => [row["turn"], row["kind"]]),
        ).toEqual([
          [started.turn, "text.delta"],
          [started.turn, "turn.end"],
        ]);
        expect(
          db.all("SELECT id, end_reason FROM turns WHERE id = ?", [
            started.turn,
          ]),
        ).toEqual([{ id: started.turn, end_reason: "completed" }]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "settles dispatched and queued prompts as bot-not-running and saves both in the command ledger on channel failure",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "aphelion-s17-"));
        const db = openStore(join(dir, "aphelion.db"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
          }),
        );
        const logger = createLogger({ write: () => undefined });
        const encoder = new TextEncoder();
        let blockWrites = false;
        let tornDown = false;
        let repliesController:
          ReadableStreamDefaultController<Uint8Array> | undefined;
        const dispatchedBlocked = yield* Deferred.make<undefined>();
        const runnerFailed = yield* Deferred.make<undefined>();
        const repliesStream = new ReadableStream<Uint8Array>({
          start(controller) {
            repliesController = controller;
          },
        });
        const emitReply = (reply: RunnerReply) => {
          if (!tornDown) {
            repliesController?.enqueue(
              encoder.encode(`${JSON.stringify(reply)}\n`),
            );
          }
        };
        const baseLink = yield* pipeLink(
          repliesStream,
          (line) => {
            const message = JSON.parse(line) as RunnerRequest;
            if (blockWrites) {
              if (message.type === "turn.start") {
                Deferred.doneUnsafe(dispatchedBlocked, Exit.succeed(undefined));
              }
              return new Promise(() => undefined);
            }
            if (message.type === "start") {
              emitReply({
                type: "spawned",
                bot: message.bot,
                run: message.run,
              });
              emitReply({
                type: "started",
                bot: message.bot,
                run: message.run,
              });
            }
            return Promise.resolve();
          },
          {
            schema: runnerReplySchema,
            maxBytes: maxFrameBytes,
            onDrop: () => Effect.void,
          },
          runnerRequestSchema,
        );
        const gatedLink = {
          incoming: baseLink.incoming,
          send: baseLink.send,
          close: Effect.sync(() => {
            if (tornDown) return;
            tornDown = true;
            repliesController?.close();
          }),
        };
        const services = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(BotRunnerLink, gatedLink),
            memorySessionRefs,
          ),
        );
        const app = yield* Scope.make();
        const { history, ledger, bots } = yield* Effect.gen(function* () {
          const history = yield* openEventStore(db, readServerId(db), {
            logger,
          });
          const ledger = yield* openCommandLedger(db, logger);
          const bots = yield* runBots(
            {
              bots: [{ name: "chief", provider: "fake", folder }],
              logger,
              policy,
              adapters: { fake: "/adapters/fake/adapter.js" },
              turnAcceptDeadlineMs: 5_000,
              writeDeadlineMs: 60,
              onChannelFailed: () =>
                Deferred.succeed(runnerFailed, undefined).pipe(Effect.asVoid),
            },
            history,
          ).pipe(Effect.provideContext(services));
          return { history, ledger, bots };
        }).pipe(Scope.provide(app));

        yield* bots
          .waitFor("chief", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        const device = deviceId.parse("0123456789abcdef");
        const admission = createAdmission();
        const context = { bots, ledger, admission, logger, history };
        const promptFrame = (id: string, text: string) =>
          ({
            v: version,
            type: "command",
            id: commandId.parse(id),
            name: "bot.prompt",
            payload: { bot: "chief", text },
          }) as const;

        blockWrites = true;
        yield* dispatch(
          context,
          device,
          promptFrame("cmd-dispatched", "first"),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(dispatchedBlocked).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        yield* dispatch(
          context,
          device,
          promptFrame("cmd-queued", "second"),
        ).pipe(Effect.forkScoped);
        yield* Effect.sleep("15 millis");

        yield* Deferred.await(runnerFailed).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        yield* Scope.close(app, Exit.void);

        expect(
          db.all("SELECT id, state, result FROM commands ORDER BY id"),
        ).toEqual([
          { id: "cmd-dispatched", state: "failed", result: "bot-not-running" },
          { id: "cmd-queued", state: "failed", result: "bot-not-running" },
        ]);
        expect(db.all("SELECT end_reason FROM turns")).toEqual([
          { end_reason: "refused" },
          { end_reason: "refused" },
        ]);

        const restarted = yield* openCommandLedger(db, logger);
        expect(
          yield* restarted.run(
            {
              device,
              id: commandId.parse("cmd-dispatched"),
              name: "bot.prompt",
            },
            Effect.succeed({ ok: true, result: { turn: "never" } }),
          ),
        ).toEqual({ ok: false, code: "bot-not-running" });
        expect(
          yield* restarted.run(
            { device, id: commandId.parse("cmd-queued"), name: "bot.prompt" },
            Effect.succeed({ ok: true, result: { turn: "never" } }),
          ),
        ).toEqual({ ok: false, code: "bot-not-running" });
      }).pipe(Effect.scoped),
  );

  it.live(
    "completes teardown, signals failure, settles pending turns, and closes the scope when a mailbox worker exits on a bot_sessions write failure before the runner queue closes",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "aphelion-s18-"));
        const db = openStore(join(dir, "aphelion.db"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
          }),
        );
        db.run(`
          CREATE TRIGGER fail_bot_sessions_insert
          BEFORE INSERT ON bot_sessions
          BEGIN
            SELECT RAISE(ABORT, 'forced bot_sessions insert failure');
          END
        `);
        const logger = createLogger({ write: () => undefined });
        const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
        const dispatched = yield* Deferred.make<undefined>();
        const runnerFailed = yield* Deferred.make<undefined>();
        const link: Context.Service.Shape<typeof BotRunnerLink> = {
          incoming,
          send: (message) =>
            Effect.gen(function* () {
              if (message.type === "start") {
                yield* Queue.offer(incoming, {
                  type: "spawned",
                  bot: message.bot,
                  run: message.run,
                });
                yield* Queue.offer(incoming, {
                  type: "started",
                  bot: message.bot,
                  run: message.run,
                });
                return;
              }
              if (message.type === "turn.start") {
                yield* Deferred.succeed(dispatched, undefined);
              }
            }),
        };
        const services = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(BotRunnerLink, link),
            sqliteSessionRefs(db, readServerId(db)),
          ),
        );
        const app = yield* Scope.make();
        const { history, ledger, bots } = yield* Effect.gen(function* () {
          const history = yield* openEventStore(db, readServerId(db), {
            logger,
          });
          const ledger = yield* openCommandLedger(db, logger);
          const bots = yield* runBots(
            {
              bots: [{ name: "chief", provider: "fake", folder }],
              logger,
              policy,
              adapters: { fake: "/adapters/fake/adapter.js" },
              stopDeadlineMs: 500,
              turnAcceptDeadlineMs: 5_000,
              onChannelFailed: () =>
                Deferred.succeed(runnerFailed, undefined).pipe(Effect.asVoid),
            },
            history,
          ).pipe(Effect.provideContext(services));
          return { history, ledger, bots };
        }).pipe(Scope.provide(app));

        yield* bots
          .waitFor("chief", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        const device = deviceId.parse("0123456789abcdef");
        const admission = createAdmission();
        const context = { bots, ledger, admission, logger, history };
        const promptFrame = (id: string, text: string) =>
          ({
            v: version,
            type: "command",
            id: commandId.parse(id),
            name: "bot.prompt",
            payload: { bot: "chief", text },
          }) as const;

        yield* dispatch(
          context,
          device,
          promptFrame("cmd-dispatched", "first"),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(dispatched).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );

        yield* Queue.offer(incoming, {
          type: "event",
          bot: "chief",
          run: 1,
          envelope: {
            seq: 1,
            turn: null,
            event: { type: "session", ref: sessionRef.parse("s-fail") },
          },
        });
        yield* Effect.sleep("40 millis");

        yield* dispatch(
          context,
          device,
          promptFrame("cmd-queued", "second"),
        ).pipe(Effect.forkScoped);
        yield* Effect.sleep("20 millis");

        yield* Queue.end(incoming);

        const failedSignal = yield* Deferred.await(runnerFailed).pipe(
          Effect.timeoutOption("1 second"),
        );
        const closing = yield* Effect.forkDetach(Scope.close(app, Exit.void));
        const closed = yield* Fiber.await(closing).pipe(
          Effect.timeoutOption("1 second"),
        );

        expect(failedSignal._tag).toBe("Some");
        expect(closed._tag).toBe("Some");
        expect(
          db.all("SELECT id, state, result FROM commands ORDER BY id"),
        ).toEqual([
          { id: "cmd-dispatched", state: "failed", result: "bot-not-running" },
          { id: "cmd-queued", state: "failed", result: "bot-not-running" },
        ]);
        expect(db.all("SELECT end_reason FROM turns")).toEqual([
          { end_reason: "refused" },
          { end_reason: "refused" },
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "stops and joins a hung mailbox worker at the drain deadline, settles its pending turns, and does not replay another bot's drained events",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "aphelion-s18-deadline-"));
        const db = openStore(join(dir, "aphelion.db"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            db.close();
            rmSync(dir, { recursive: true, force: true });
          }),
        );
        const logger = createLogger({ write: () => undefined });
        const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
        const alphaDispatched = yield* Deferred.make<undefined>();
        const alphaStuck = yield* Deferred.make<undefined>();
        const runnerFailed = yield* Deferred.make<undefined>();
        let alphaInterrupted = false;
        const link: Context.Service.Shape<typeof BotRunnerLink> = {
          incoming,
          send: (message) =>
            Effect.gen(function* () {
              if (message.type === "start") {
                yield* Queue.offer(incoming, {
                  type: "spawned",
                  bot: message.bot,
                  run: message.run,
                });
                yield* Queue.offer(incoming, {
                  type: "started",
                  bot: message.bot,
                  run: message.run,
                });
                return;
              }
              if (message.type === "turn.start" && message.bot === "alpha") {
                yield* Deferred.succeed(alphaDispatched, undefined);
                return;
              }
              if (message.type === "turn.start" && message.bot === "beta") {
                yield* Queue.offer(incoming, {
                  type: "turn.accepted",
                  bot: message.bot,
                  run: message.run,
                  turn: message.turn,
                });
              }
            }),
        };
        const hangingRefs = Layer.succeed(
          SessionRefs,
          SessionRefs.of({
            get: () => Effect.succeed(undefined),
            set: (bot) =>
              bot === "alpha"
                ? Deferred.succeed(alphaStuck, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        alphaInterrupted = true;
                      }),
                    ),
                  )
                : Effect.void,
            clear: () => Effect.void,
          }),
        );
        const services = yield* Layer.build(
          Layer.mergeAll(Layer.succeed(BotRunnerLink, link), hangingRefs),
        );
        const app = yield* Scope.make();
        const { history, ledger, bots } = yield* Effect.gen(function* () {
          const history = yield* openEventStore(db, readServerId(db), {
            logger,
          });
          const ledger = yield* openCommandLedger(db, logger);
          const bots = yield* runBots(
            {
              bots: [
                {
                  name: "alpha",
                  provider: "fake",
                  folder: "/var/lib/aphelion-bots/alpha",
                },
                {
                  name: "beta",
                  provider: "fake",
                  folder: "/var/lib/aphelion-bots/beta",
                },
              ],
              logger,
              policy,
              adapters: { fake: "/adapters/fake/adapter.js" },
              drainDeadlineMs: 80,
              stopDeadlineMs: 1_000,
              turnAcceptDeadlineMs: 5_000,
              onChannelFailed: () =>
                Deferred.succeed(runnerFailed, undefined).pipe(Effect.asVoid),
            },
            history,
          ).pipe(Effect.provideContext(services));
          return { history, ledger, bots };
        }).pipe(Scope.provide(app));

        yield* bots
          .waitFor("alpha", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);
        yield* bots
          .waitFor("beta", (state) => state.state === "running")
          .pipe(Effect.timeout("2 seconds"), Effect.orDie);

        const betaTurn = yield* bots.startTurn("beta", "finish");
        expect(betaTurn.outcome).toBe("accepted");

        const device = deviceId.parse("0123456789abcdef");
        const admission = createAdmission();
        const context = { bots, ledger, admission, logger, history };
        const promptFrame = (id: string, bot: string, text: string) =>
          ({
            v: version,
            type: "command",
            id: commandId.parse(id),
            name: "bot.prompt",
            payload: { bot, text },
          }) as const;

        yield* dispatch(
          context,
          device,
          promptFrame("cmd-alpha-dispatched", "alpha", "first"),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(alphaDispatched).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );

        yield* Queue.offer(incoming, {
          type: "event",
          bot: "alpha",
          run: 1,
          envelope: {
            seq: 1,
            turn: null,
            event: { type: "session", ref: sessionRef.parse("s-hang") },
          },
        });
        yield* Deferred.await(alphaStuck).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );

        yield* dispatch(
          context,
          device,
          promptFrame("cmd-alpha-queued", "alpha", "second"),
        ).pipe(Effect.forkScoped);
        yield* Queue.offer(incoming, {
          type: "event",
          bot: "beta",
          run: 1,
          envelope: {
            seq: 1,
            turn: betaTurn.turn,
            event: { type: "text.delta", text: "done" },
          },
        });
        yield* Queue.offer(incoming, {
          type: "event",
          bot: "beta",
          run: 1,
          envelope: {
            seq: 2,
            turn: betaTurn.turn,
            event: { type: "turn.end", reason: "completed" },
          },
        });
        yield* Effect.sleep("20 millis");

        yield* Queue.end(incoming);

        const failedSignal = yield* Deferred.await(runnerFailed).pipe(
          Effect.timeoutOption("1 second"),
        );
        const closing = yield* Effect.forkDetach(Scope.close(app, Exit.void));
        const closed = yield* Fiber.await(closing).pipe(
          Effect.timeoutOption("1 second"),
        );

        expect(failedSignal._tag).toBe("Some");
        expect(closed._tag).toBe("Some");
        expect(alphaInterrupted).toBe(true);
        expect(
          db.all("SELECT id, state, result FROM commands ORDER BY id"),
        ).toEqual([
          {
            id: "cmd-alpha-dispatched",
            state: "failed",
            result: "bot-not-running",
          },
          {
            id: "cmd-alpha-queued",
            state: "failed",
            result: "bot-not-running",
          },
        ]);
        expect(
          db
            .all("SELECT bot, turn, kind FROM events ORDER BY position")
            .map((row) => [row["bot"], row["turn"], row["kind"]]),
        ).toEqual([
          ["alpha", null, "session"],
          ["beta", betaTurn.turn, "text.delta"],
          ["beta", betaTurn.turn, "turn.end"],
        ]);
        expect(
          db.all("SELECT id, end_reason FROM turns WHERE id = ?", [
            betaTurn.turn,
          ]),
        ).toEqual([{ id: betaTurn.turn, end_reason: "completed" }]);
      }).pipe(Effect.scoped),
  );
});

describe("the bot manager", () => {
  it.live(
    "starts a bot, runs a turn, publishes its events, saves its session, and stops it",
    () =>
      Effect.gen(function* () {
        const chief = recording([sessionTurn]);
        const { manager, refs, seen, reach } = yield* system(chief.bot);
        expect(yield* manager.start("chief")).toBe("starting");
        yield* reach("running");
        const started = yield* manager.startTurn("chief", "hi");
        expect(started.outcome).toBe("accepted");
        expect(started.turn).toMatch(uuidV7);
        yield* reach("running");
        expect(
          seen.map(({ bot, envelope }) => [bot, envelope.event.type]),
        ).toEqual([
          ["chief", "session"],
          ["chief", "text.delta"],
          ["chief", "turn.end"],
        ]);
        expect(
          seen
            .filter(({ envelope }) => envelope.turn !== null)
            .map(({ envelope }) => envelope.turn),
        ).toEqual([started.turn, started.turn]);
        expect(yield* refs.get("chief")).toEqual({
          ref: "s-1",
          folder,
          provider: "fake",
        });
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
        expect((yield* manager.startTurn("chief", "hi")).outcome).toBe(
          "not-running",
        );
        yield* manager.start("chief");
        yield* reach("running");
        const first = yield* manager.startTurn("chief", "hi");
        expect(first.outcome).toBe("accepted");
        expect(yield* manager.status("chief")).toEqual({
          state: "in turn",
          turn: first.turn,
        });
        expect((yield* manager.startTurn("chief", "hi")).outcome).toBe("busy");
        expect(
          (yield* manager.startTurn("chief", "a".repeat(256 * 1024 + 1)))
            .outcome,
        ).toBe("too-long");
        yield* manager.cancelTurn("chief", first.turn);
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
        yield* manager.startTurn("chief", "work");
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

  it.live(
    "logs how many lines a bot wrote to stderr, never the lines themselves",
    () =>
      Effect.gen(function* () {
        const { fake, logs, manager, reach } = yield* system({
          adapter: () => fakeAdapter([]),
        });
        yield* manager.start("chief");
        yield* reach("running");
        const run = fake.latest("chief");
        run?.writeStderr("the user asked: where is my secret plan?");
        run?.writeStderr("and then: more of the conversation");
        yield* Effect.sleep("50 millis");

        const notes = logs.filter(
          (log) => log["msg"] === "bot wrote to stderr",
        );
        expect(notes.map((log) => [log["bot"], log["lines"]])).toEqual([
          ["chief", 1],
          ["chief", 2],
        ]);
        expect(JSON.stringify(logs)).not.toContain("secret plan");
        expect(JSON.stringify(logs)).not.toContain("conversation");
      }).pipe(Effect.scoped),
  );

  it.live(
    "records each turn with the ledger before the adapter sees it, and ends one the bot refuses",
    () =>
      Effect.gen(function* () {
        const chief = recording([sessionTurn, [{ waitForAbort: true }]]);
        const calls: string[] = [];
        const { manager, seen, reach } = yield* system(
          chief.bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          {
            open: (bot, turn) =>
              Effect.sync(() => {
                calls.push(`open ${bot} ${turn}`);
                return true;
              }),
            end: (turn, reason) =>
              Effect.sync(() => {
                calls.push(`end ${turn} ${reason}`);
              }),
          },
        );
        yield* manager.start("chief");
        yield* reach("running");
        const first = yield* manager.startTurn("chief", "hi");
        yield* reach("running");
        expect(first.outcome).toBe("accepted");
        expect(calls).toEqual([`open chief ${first.turn}`]);
        expect(seen.length).toBeGreaterThan(0);

        const second = yield* manager.startTurn("chief", "again");
        expect(second.outcome).toBe("accepted");
        const busy = yield* manager.startTurn("chief", "too soon");
        expect(busy.outcome).toBe("busy");
        expect(calls.slice(1)).toEqual([
          `open chief ${second.turn}`,
          `open chief ${busy.turn}`,
          `end ${busy.turn} refused`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "ends a turn the adapter refuses after its caller stopped waiting",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
        const { manager, reach } = yield* system(
          recording([sessionTurn]).bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          {
            open: (_bot, turn) =>
              Effect.sync(() => {
                calls.push(`open ${turn}`);
                return true;
              }),
            end: (turn, reason) =>
              Effect.sync(() => {
                calls.push(`end ${turn} ${reason}`);
              }),
          },
          (link) => {
            Effect.runFork(
              Queue.take(link.incoming).pipe(
                Effect.flatMap((reply) => Queue.offer(incoming, reply)),
                Effect.forever,
                Effect.ignore,
              ),
            );
            return {
              incoming,
              send: (message) =>
                message.type === "turn.start"
                  ? Effect.void
                  : link.send(message),
            };
          },
        );
        yield* manager.start("chief");
        yield* reach("running");
        const caller = yield* manager
          .startTurn("chief", "hi")
          .pipe(Effect.forkScoped);
        yield* Effect.sleep("30 millis");
        yield* Fiber.interrupt(caller);
        const opened = calls[0]?.slice("open ".length) ?? "";
        expect(calls).toEqual([`open ${opened}`]);

        yield* Queue.offer(incoming, {
          type: "turn.refused",
          bot: "chief",
          run: 1,
          turn: turnId.parse(opened),
          reason: "refused",
        });
        yield* Effect.sleep("30 millis");
        expect(calls).toEqual([`open ${opened}`, `end ${opened} refused`]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "ends the turn row when the caller is interrupted while the ledger opens it",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const { manager, reach } = yield* system(
          recording([[{ waitForAbort: true }]]).bot,
          () => Effect.void,
          "fake",
          memorySessionRefs,
          {
            open: (_bot, turn) =>
              Effect.sleep("40 millis").pipe(
                Effect.as(true),
                Effect.tap(() =>
                  Effect.sync(() => {
                    calls.push(`open ${turn}`);
                  }),
                ),
              ),
            end: (turn, reason) =>
              Effect.sync(() => {
                calls.push(`end ${turn} ${reason}`);
              }),
          },
        );
        yield* manager.start("chief");
        yield* reach("running");
        const first = yield* manager.startTurn("chief", "first");
        const caller = yield* manager
          .startTurn("chief", "second")
          .pipe(Effect.forkScoped);
        yield* Effect.sleep("10 millis");
        yield* Fiber.interrupt(caller);
        yield* Effect.sleep("100 millis");

        expect(first.outcome).toBe("accepted");
        expect(calls).toHaveLength(3);
        expect(calls[1]).toMatch(/^open /);
        expect(calls[2]).toBe(
          `end ${calls[1]?.slice("open ".length) ?? ""} refused`,
        );
      }).pipe(Effect.scoped),
  );

  it.live("refuses a turn the ledger can't record, without sending it", () =>
    Effect.gen(function* () {
      const chief = recording([sessionTurn]);
      const { manager, seen, reach } = yield* system(
        chief.bot,
        () => Effect.void,
        "fake",
        memorySessionRefs,
        { open: () => Effect.succeed(false), end: () => Effect.void },
      );
      yield* manager.start("chief");
      yield* reach("running");
      expect((yield* manager.startTurn("chief", "hi")).outcome).toBe("refused");
      yield* Effect.sleep("30 millis");
      expect(seen).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "logs a runner diagnostic with its own fixed line, never counts it as stderr, and never logs the adapter's text",
    () =>
      Effect.gen(function* () {
        const { fake, logs, manager, reach } = yield* system({
          adapter: () => fakeAdapter([]),
        });
        yield* manager.start("chief");
        yield* reach("running");
        fake
          .latest("chief")
          ?.say("the user asked: where is my secret plan? not json");
        yield* Effect.sleep("50 millis");

        expect(logs.map((log) => log["msg"])).toContain(
          runnerNotices["not-a-message"],
        );
        expect(logs.some((log) => log["msg"] === "bot wrote to stderr")).toBe(
          false,
        );
        expect(JSON.stringify(logs)).not.toContain("secret plan");
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
            saved.set("chief", {
              ref: sessionRef.parse("s-old"),
              folder,
              provider: "fake",
            }),
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

  it.live(
    "saves the session in the database, and a new server resumes it from there",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "aphelion-bot-sessions-"));
        const path = join(dir, "aphelion.db");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            rmSync(dir, { recursive: true });
          }),
        );
        const first = openStore(path);
        const firstChief = recording([sessionTurn]);
        const one = yield* system(
          firstChief.bot,
          () => Effect.void,
          "fake",
          sqliteSessionRefs(first, readServerId(first)),
        );
        yield* one.manager.start("chief");
        yield* one.reach("running");
        yield* one.manager.startTurn("chief", "hi");
        yield* one.reach("running");
        yield* one.manager.stop("chief");
        expect(firstChief.made[0]?.contexts[0]?.resume).toBeNull();
        first.close();

        const second = openStore(path);
        const secondChief = recording([]);
        const two = yield* system(
          secondChief.bot,
          () => Effect.void,
          "fake",
          sqliteSessionRefs(second, readServerId(second)),
        );
        yield* two.manager.start("chief");
        yield* two.reach("running");
        expect(secondChief.made[0]?.contexts[0]?.resume).toBe("s-1");
        second.close();
      }).pipe(Effect.scoped),
  );

  it.live("doesn't resume a session saved for another folder", () =>
    Effect.gen(function* () {
      const chief = recording([]);
      const { manager, reach } = yield* system(chief.bot, (saved) =>
        saved.set("chief", {
          ref: sessionRef.parse("s-1"),
          folder: "/var/lib/aphelion-bots/old-name",
          provider: "fake",
        }),
      );
      yield* manager.start("chief");
      yield* reach("running");
      expect(chief.made[0]?.contexts[0]?.resume).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.live("doesn't resume a session saved for another provider", () =>
    Effect.gen(function* () {
      const chief = recording([]);
      const { manager, reach } = yield* system(chief.bot, (saved) =>
        saved.set("chief", {
          ref: sessionRef.parse("s-1"),
          folder,
          provider: "codex",
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

  it.live(
    "gives every turn its own server-made ID and sends it to the adapter",
    () =>
      Effect.gen(function* () {
        const chief = recording([sessionTurn, sessionTurn]);
        const { fake, manager, reach } = yield* system(chief.bot);
        yield* manager.start("chief");
        yield* reach("running");
        const one = yield* manager.startTurn("chief", "hi");
        yield* reach("running");
        const two = yield* manager.startTurn("chief", "again");
        yield* reach("running");

        expect(one.turn).not.toBe(two.turn);
        expect(
          fake
            .latest("chief")
            ?.received.filter((line) => line.method === "turn.start")
            .map((line) => (line.params as { turn: string }).turn),
        ).toEqual([one.turn, two.turn]);
      }).pipe(Effect.scoped),
  );
});
