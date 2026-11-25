import { maxPluginLineBytes } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import { describe } from "vitest";
import { createLogger } from "../log";
import { memoryLinkPair, type Framing } from "./link";
import { PluginProcesses, type ProcessExit } from "./processes";
import { runRunner, stoppedReading } from "./runner";
import {
  maxFrameBytes,
  maxPendingInputBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

const silentProcesses = Layer.succeed(PluginProcesses, {
  sweep: Effect.succeed({ survivors: 0 }),
  spawn: () =>
    Effect.gen(function* () {
      const exit = yield* Deferred.make<ProcessExit>();
      return {
        write: () => Effect.never,
        stdout: Stream.empty,
        stderr: Stream.empty,
        exited: Deferred.await(exit),
        kill: Effect.succeed({ survivors: 0 }),
      };
    }),
});

const sendInputs = (lines: readonly string[]) =>
  Effect.gen(function* () {
    const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
      framing(runnerReplySchema),
      framing(runnerRequestSchema),
    );
    yield* runRunner(b, {
      dataRoot: "/data",
      sweepEvery: "1 hour",
      inputDeadline: "1 hour",
      logger: createLogger({ write: () => undefined }),
    }).pipe(Effect.provide(silentProcesses), Effect.forkScoped);
    yield* a.send({
      type: "start",
      plugin: "sampler",
      run: 1,
      folder: "/plugins/sampler",
      entry: "index.js",
    });
    for (const line of lines) {
      yield* a.send({ type: "input", plugin: "sampler", run: 1, line });
    }
    yield* a.send({ type: "stop", plugin: "sampler", run: 1 });
    const replies: RunnerReply[] = [];
    for (;;) {
      const reply = yield* Queue.take(a.incoming);
      replies.push(reply);
      if (reply.type === "stopped") return replies;
    }
  }).pipe(Effect.scoped);

const stoppedForFlood = (replies: readonly RunnerReply[]) =>
  replies.some(
    (reply) => reply.type === "log" && reply.line === stoppedReading,
  );

const japanese = "あ".repeat(maxPluginLineBytes);
const ascii = "a".repeat(maxPluginLineBytes);

describe("the plugin input queue budget", () => {
  it.live(
    "counts multibyte input in UTF-8 bytes, so text over the budget in bytes trips it",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 6 }, () => japanese);
        const total = lines.reduce((sum, line) => sum + line.length, 0);
        expect(total).toBeLessThan(maxPendingInputBytes);
        expect(total * 3).toBeGreaterThan(maxPendingInputBytes);
        const replies = yield* sendInputs(lines);
        expect(stoppedForFlood(replies)).toBe(true);
      }),
    30_000,
  );

  it.live(
    "accepts multibyte input that stays under the budget in UTF-8 bytes",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 5 }, () => japanese);
        const bytes = lines.length * maxPluginLineBytes * 3;
        expect(bytes).toBeLessThan(maxPendingInputBytes);
        const replies = yield* sendInputs(lines);
        expect(stoppedForFlood(replies)).toBe(false);
      }),
    30_000,
  );

  it.live(
    "trips the budget for ASCII input of the same byte size as the multibyte overflow",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 18 }, () => ascii);
        expect(lines.length * maxPluginLineBytes).toBeGreaterThan(
          maxPendingInputBytes,
        );
        const replies = yield* sendInputs(lines);
        expect(stoppedForFlood(replies)).toBe(true);
      }),
    30_000,
  );

  it.live(
    "accepts ASCII input under the budget",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 15 }, () => ascii);
        expect(lines.length * maxPluginLineBytes).toBeLessThan(
          maxPendingInputBytes,
        );
        const replies = yield* sendInputs(lines);
        expect(stoppedForFlood(replies)).toBe(false);
      }),
    30_000,
  );
});
