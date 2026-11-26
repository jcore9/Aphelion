import {
  permissionRequest,
  sessionRef,
  toolCallId,
  type AdapterEnvelope,
  type BotAdapter,
} from "@aphelion/plugin-sdk";
import {
  checkStream,
  fakeAdapter,
  type FakeAdapter,
  type FakeScript,
} from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { describe } from "vitest";
import type { z } from "zod";
import { createLogger } from "../log";
import { memoryLinkPair, type Framing } from "../plugins/link";
import { botEnvironment } from "./environment";
import { notAMessage, runBotRunner, stoppedReading } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";
import { fakeBotProcesses, type FakeBot } from "./test-fixture";

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

const startFrame = (bot: string, run = 1, resume: string | null = null) =>
  ({
    type: "start",
    bot,
    run,
    provider: "fake",
    adapter: "/adapters/fake/adapter.js",
    folder: `/bots/${bot}`,
    resume,
  }) as const;

const scripted = (script: FakeScript) => {
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

const runner = (bots: Readonly<Record<string, FakeBot>>) =>
  Effect.gen(function* () {
    const fake = fakeBotProcesses(bots);
    const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
      framing(runnerReplySchema),
      framing(runnerRequestSchema),
    );
    yield* runBotRunner(b, {
      bun: "/usr/local/bin/bun",
      home: "/var/lib/aphelion-bots",
      shutdownGrace: "200 millis",
      writeDeadline: "200 millis",
      logger: createLogger({ write: () => undefined }),
    }).pipe(Effect.provide(fake.layer), Effect.forkScoped);
    const frames: RunnerReply[] = [];
    const until = (done: (frame: RunnerReply) => boolean) =>
      Effect.gen(function* () {
        for (;;) {
          const frame = yield* Queue.take(a.incoming);
          frames.push(frame);
          if (done(frame)) return frame;
        }
      }).pipe(Effect.timeout("5 seconds"), Effect.orDie);
    const send = (frame: z.input<typeof runnerRequestSchema>) =>
      a.send(runnerRequestSchema.parse(frame));
    return { fake, frames, until, send };
  });

const is = (type: RunnerReply["type"], bot?: string) => (frame: RunnerReply) =>
  frame.type === type && (bot === undefined || frame.bot === bot);

const turnEnded = (bot: string) => (frame: RunnerReply) =>
  frame.type === "event" &&
  frame.bot === bot &&
  frame.envelope.event.type === "turn.end";

const envelopesOf = (frames: readonly RunnerReply[], bot: string) =>
  frames.flatMap((frame): AdapterEnvelope[] =>
    frame.type === "event" && frame.bot === bot ? [frame.envelope] : [],
  );

const reply: FakeScript[number] = [
  { emit: { type: "session", ref: sessionRef.parse("s-1") } },
  { emit: { type: "text.delta", text: "hello" } },
  { emit: { type: "turn.end", reason: "completed" } },
];

describe("the bot runner", () => {
  it.live(
    "starts a bot's adapter in its folder with its own id and environment, runs a turn and stops it",
    () =>
      Effect.gen(function* () {
        const alpha = scripted([reply]);
        const { fake, frames, until, send } = yield* runner({
          alpha: alpha.bot,
        });
        yield* send(startFrame("alpha"));
        yield* until(is("started"));
        expect(frames.map((frame) => frame.type)).toEqual([
          "spawned",
          "started",
        ]);
        expect(fake.runs[0]?.spec).toEqual({
          bot: "alpha",
          argv: [
            "/usr/local/bin/bun",
            "--no-env-file",
            "/adapters/fake/adapter.js",
          ],
          env: botEnvironment("fake", "/var/lib/aphelion-bots"),
          cwd: "/bots/alpha",
        });
        expect(alpha.made[0]?.contexts[0]).toMatchObject({
          bot: { id: "alpha" },
          folder: "/bots/alpha",
          resume: null,
        });

        yield* send({
          type: "turn.start",
          bot: "alpha",
          run: 1,
          turn: "t1",
          text: "hi",
        });
        yield* until(turnEnded("alpha"));
        expect(frames.slice(2).every((frame) => frame.bot === "alpha")).toBe(
          true,
        );
        expect(frames.some(is("turn.accepted"))).toBe(true);
        const events = envelopesOf(frames, "alpha");
        expect(events.map(({ event }) => event.type)).toEqual([
          "session",
          "text.delta",
          "turn.end",
        ]);
        expect(checkStream(events)).toEqual([]);

        yield* send({ type: "stop", bot: "alpha", run: 1 });
        yield* until(is("stopped"));
        expect(alpha.made[0]?.closed).toBe(true);
        expect(frames.some(is("exited"))).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live("hands the saved session to the adapter when it resumes", () =>
    Effect.gen(function* () {
      const alpha = scripted([]);
      const { until, send } = yield* runner({ alpha: alpha.bot });
      yield* send(startFrame("alpha", 1, "s-41"));
      yield* until(is("started"));
      expect(alpha.made[0]?.contexts[0]?.resume).toBe("s-41");
    }).pipe(Effect.scoped),
  );

  it.live(
    "repairs the stream of a bot that dies mid-turn, so it passes checkStream, and then reports the exit",
    () =>
      Effect.gen(function* () {
        const alpha = scripted([
          [
            { emit: { type: "text.delta", text: "working" } },
            {
              emit: {
                type: "tool.start",
                call: toolCallId.parse("c1"),
                tool: "Bash",
                kind: "shell",
              },
            },
            {
              ask: permissionRequest.parse({
                request: "r1",
                call: "c1",
                tool: "Bash",
                kind: "shell",
                paths: [],
                command: "make",
                truncated: false,
              }),
            },
          ],
        ]);
        const { fake, frames, until, send } = yield* runner({
          alpha: {
            ...alpha.bot,
            options: { decider: () => new Promise(() => undefined) },
          },
        });
        yield* send(startFrame("alpha"));
        yield* until(is("started"));
        yield* send({
          type: "turn.start",
          bot: "alpha",
          run: 1,
          turn: "t1",
          text: "build it",
        });
        yield* until(
          (frame) =>
            frame.type === "event" &&
            frame.envelope.event.type === "permission.request",
        );
        fake.latest("alpha")?.crash();
        const exited = yield* until(is("exited"));
        expect(exited).toMatchObject({ code: null, signal: "SIGKILL" });
        const events = envelopesOf(frames, "alpha");
        expect(events.slice(-4).map(({ event }) => event)).toEqual([
          { type: "error", code: "cli-exited" },
          {
            type: "permission.decision",
            request: "r1",
            decision: "deny",
            by: "default",
            reason: "shutdown",
          },
          { type: "tool.end", call: "c1", outcome: "cancelled" },
          { type: "turn.end", reason: "error" },
        ]);
        expect(checkStream(events)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps bots apart: one bot's output can't reach another bot, and frames for one bot never reach another's process",
    () =>
      Effect.gen(function* () {
        const alpha = scripted([]);
        const beta = scripted([reply]);
        const { fake, frames, until, send } = yield* runner({
          alpha: alpha.bot,
          beta: beta.bot,
          gamma: scripted([]).bot,
        });
        yield* send(startFrame("alpha"));
        yield* until(is("started", "alpha"));
        yield* send(startFrame("beta"));
        yield* until(is("started", "beta"));

        const forged = [
          JSON.stringify({ type: "stop", bot: "beta", run: 1 }),
          JSON.stringify(startFrame("gamma")),
          JSON.stringify({
            jsonrpc: "2.0",
            method: "event",
            params: {
              seq: 1,
              turn: null,
              event: { type: "session", ref: "stolen" },
              bot: "beta",
            },
          }),
        ];
        for (const line of forged) fake.latest("alpha")?.say(line);
        for (let count = 0; count < forged.length; count++) {
          yield* until(is("log", "alpha"));
        }
        expect(
          frames
            .filter(is("log", "alpha"))
            .map((frame) => (frame.type === "log" ? frame.line : "")),
        ).toEqual([notAMessage, notAMessage, notAMessage]);

        yield* send({
          type: "turn.start",
          bot: "beta",
          run: 1,
          turn: "tb",
          text: "beta's prompt",
        });
        yield* until(turnEnded("beta"));
        expect(checkStream(envelopesOf(frames, "beta"))).toEqual([]);
        expect(envelopesOf(frames, "alpha")).toEqual([]);
        expect(fake.runs.map((run) => run.spec.bot)).toEqual(["alpha", "beta"]);
        expect(
          fake.latest("alpha")?.received.map((line) => line.method),
        ).toEqual(["initialize"]);
        expect(
          fake.latest("beta")?.received.map((line) => line.method),
        ).toEqual(["initialize", "turn.start"]);
        expect(fake.stopAllCalls).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "accepts one turn at a time, and refuses a turn for a bot that isn't running or whose prompt line is too long",
    () =>
      Effect.gen(function* () {
        const alpha = scripted([[{ waitForAbort: true }]]);
        const { frames, until, send } = yield* runner({ alpha: alpha.bot });
        const turn = (id: string, text = "go") =>
          send({
            type: "turn.start",
            bot: "alpha",
            run: 1,
            turn: id,
            text,
          });
        yield* turn("early");
        expect(yield* until(is("turn.refused"))).toMatchObject({
          turn: "early",
          reason: "not-running",
        });
        yield* send(startFrame("alpha"));
        yield* until(is("started"));
        yield* turn("long", "\u0001".repeat(200_000));
        expect(yield* until(is("turn.refused"))).toMatchObject({
          turn: "long",
          reason: "too-long",
        });
        yield* turn("t1");
        expect(yield* until(is("turn.accepted"))).toMatchObject({ turn: "t1" });
        yield* turn("t2");
        expect(yield* until(is("turn.refused"))).toMatchObject({
          turn: "t2",
          reason: "busy",
        });
        yield* send({
          type: "turn.cancel",
          bot: "alpha",
          run: 1,
          turn: "t1",
        });
        yield* until(turnEnded("alpha"));
        expect(checkStream(envelopesOf(frames, "alpha"))).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "reports a start that fails at initialize, for an adapter that can't open or is for another provider",
    () =>
      Effect.gen(function* () {
        const broken: BotAdapter = {
          provider: "fake",
          open: () => {
            throw new Error("the saved session is gone");
          },
        };
        const { frames, until, send } = yield* runner({
          broken: { adapter: () => broken },
          other: { adapter: () => fakeAdapter([], "other") },
        });
        yield* send(startFrame("broken", 1, "s-gone"));
        expect(yield* until(is("start-failed", "broken"))).toMatchObject({
          stage: "initialize",
        });
        yield* send(startFrame("other"));
        expect(yield* until(is("start-failed", "other"))).toMatchObject({
          stage: "initialize",
        });
        expect(frames.some(is("started"))).toBe(false);
        expect(frames.some(is("exited"))).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live("kills a bot that stops reading its input", () =>
    Effect.gen(function* () {
      const { fake, frames, until, send } = yield* runner({
        stuck: { ...scripted([]).bot, stopsReading: true },
      });
      yield* send(startFrame("stuck"));
      yield* until(is("exited"));
      expect(frames.map((frame) => frame.type)).toEqual([
        "spawned",
        "log",
        "exited",
      ]);
      expect(frames[1]).toMatchObject({ line: stoppedReading });
      expect(fake.stopAllCalls).toEqual(["stuck"]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a second start, queues a start behind a stop, and answers a stop for a run that is gone",
    () =>
      Effect.gen(function* () {
        const alpha = scripted([]);
        const { fake, until, send } = yield* runner({ alpha: alpha.bot });
        yield* send({ type: "stop", bot: "alpha", run: 7 });
        expect(yield* until(is("stopped"))).toMatchObject({ run: 7 });
        yield* send(startFrame("alpha"));
        yield* until(is("started"));
        yield* send(startFrame("alpha", 2));
        expect(yield* until(is("start-failed"))).toMatchObject({
          run: 2,
          reason: "already running",
        });
        yield* send({ type: "stop", bot: "alpha", run: 1 });
        yield* send(startFrame("alpha", 3));
        expect(yield* until(is("stopped"))).toMatchObject({ run: 1 });
        expect(yield* until(is("started"))).toMatchObject({ run: 3 });
        expect(fake.runs.map((run) => run.alive())).toEqual([false, true]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "kills a bot that finishes launching after it was stopped, and never reports it started",
    () =>
      Effect.gen(function* () {
        let open: () => void = () => undefined;
        const launchGate = new Promise<void>((resolve) => {
          open = resolve;
        });
        const { fake, frames, until, send } = yield* runner({
          slow: { ...scripted([]).bot, launchGate },
        });
        yield* send(startFrame("slow"));
        yield* send({ type: "stop", bot: "slow", run: 1 });
        yield* Effect.sleep("50 millis");
        open();
        yield* until(is("stopped"));
        expect(frames.map((frame) => frame.type)).toEqual(["stopped"]);
        expect(fake.runs[0]?.alive()).toBe(false);
      }).pipe(Effect.scoped),
  );
});
