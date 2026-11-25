import { maxPluginLineBytes } from "@aphelion/plugin-sdk";
import { expect, it } from "@effect/vitest";
import {
  Cause,
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
import { createLogger } from "../log";
import { memoryLinkPair, type Framing, type Link } from "./link";
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

const japanese = "あ".repeat(Math.floor(maxPluginLineBytes / 3));
const ascii = "a".repeat(maxPluginLineBytes);

describe("the plugin input queue budget", () => {
  it.live(
    "counts multibyte input in UTF-8 bytes, so text over the budget in bytes trips it",
    () =>
      Effect.gen(function* () {
        const lines = Array.from({ length: 17 }, () => japanese);
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
        const lines = Array.from({ length: 15 }, () => japanese);
        const bytes = lines.length * japanese.length * 3;
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
        const lines = Array.from({ length: 17 }, () => ascii);
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

const quietOptions = {
  dataRoot: "/data",
  sweepEvery: "1 hour",
  inputDeadline: "1 hour",
  logger: createLogger({ write: () => undefined }),
} as const;

const gatedProcesses = Effect.sync(() => {
  const holds = new Map<string, Deferred.Deferred<undefined>>();
  const spawned = new Map<string, number>();
  const trace: string[] = [];
  const alive = new Set<string>();
  const pass = (key: string) => {
    const gate = holds.get(key);
    return gate === undefined ? Effect.void : Deferred.await(gate);
  };
  const layer = Layer.succeed(PluginProcesses, {
    sweep: Effect.succeed({ survivors: 0 }),
    spawn: (spec) =>
      Effect.gen(function* () {
        const count = (spawned.get(spec.plugin) ?? 0) + 1;
        spawned.set(spec.plugin, count);
        const id = `${spec.plugin}#${String(count)}`;
        trace.push(`spawning ${id}`);
        yield* pass(`spawn ${id}`);
        alive.add(id);
        trace.push(`spawned ${id}`);
        const exit = yield* Deferred.make<ProcessExit>();
        return {
          write: () => Effect.void,
          stdout: Stream.empty,
          stderr: Stream.empty,
          exited: Deferred.await(exit),
          kill: Effect.gen(function* () {
            trace.push(`killing ${id}`);
            yield* pass(`kill ${id}`);
            alive.delete(id);
            trace.push(`reaped ${id}`);
            yield* Deferred.succeed(exit, { code: null, signal: "SIGKILL" });
            return { survivors: 0 };
          }),
        };
      }),
  });
  const hold = (key: string) =>
    Deferred.make<undefined>().pipe(
      Effect.tap((gate) => Effect.sync(() => holds.set(key, gate))),
      Effect.asVoid,
    );
  const release = (key: string) =>
    Effect.suspend(() => {
      const gate = holds.get(key);
      return gate === undefined
        ? Effect.void
        : Deferred.succeed(gate, undefined).pipe(Effect.asVoid);
    });
  return { layer, hold, release, trace, alive };
});

const label = (reply: RunnerReply) =>
  `${reply.type} ${reply.plugin} ${String(reply.run)}`;

const request = (type: "start" | "stop", plugin: string, run = 1) =>
  type === "start"
    ? ({
        type,
        plugin,
        run,
        folder: `/plugins/${plugin}`,
        entry: "index.js",
      } as const)
    : ({ type, plugin, run } as const);

const collectReplies = (incoming: Queue.Dequeue<RunnerReply, Cause.Done>) =>
  Effect.gen(function* () {
    const seen: RunnerReply[] = [];
    yield* Queue.take(incoming).pipe(
      Effect.tap((reply) => Effect.sync(() => seen.push(reply))),
      Effect.forever,
      Effect.catchIf(Cause.isDone, () => Effect.void),
      Effect.forkScoped,
    );
    const labels = () => seen.map(label);
    return { labels };
  });

const eventually = (condition: () => boolean) =>
  Effect.gen(function* () {
    while (!condition()) yield* Effect.sleep("5 millis");
  }).pipe(Effect.timeout("5 seconds"));

const settle = Effect.sleep("100 millis");

describe("the plugin runner's command order", () => {
  it.live(
    "starts and stops a plugin while another plugin's launch is stalled",
    () =>
      Effect.gen(function* () {
        const gated = yield* gatedProcesses;
        const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
          framing(runnerReplySchema),
          framing(runnerRequestSchema),
        );
        yield* runRunner(b, quietOptions).pipe(
          Effect.provide(gated.layer),
          Effect.forkScoped,
        );
        yield* gated.hold("spawn slow#1");
        const replies = yield* collectReplies(a.incoming);
        yield* a.send(request("start", "slow"));
        yield* a.send(request("start", "quick"));
        yield* eventually(() => replies.labels().includes("started quick 1"));
        yield* a.send(request("stop", "quick"));
        yield* eventually(() => replies.labels().includes("stopped quick 1"));
        expect(replies.labels()).not.toContain("started slow 1");
        yield* gated.release("spawn slow#1");
        yield* eventually(() => replies.labels().includes("started slow 1"));
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live(
    "starts a newer run only after the older run's kill has finished, and answers each stop once",
    () =>
      Effect.gen(function* () {
        const gated = yield* gatedProcesses;
        const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
          framing(runnerReplySchema),
          framing(runnerRequestSchema),
        );
        yield* runRunner(b, quietOptions).pipe(
          Effect.provide(gated.layer),
          Effect.forkScoped,
        );
        const replies = yield* collectReplies(a.incoming);
        yield* gated.hold("kill sampler#1");
        yield* Effect.addFinalizer(() => gated.release("kill sampler#1"));
        yield* a.send(request("start", "sampler", 1));
        yield* eventually(() => replies.labels().includes("started sampler 1"));
        yield* a.send(request("stop", "sampler", 1));
        yield* eventually(() => gated.trace.includes("killing sampler#1"));
        yield* a.send(request("start", "sampler", 2));
        yield* a.send(request("stop", "sampler", 1));
        yield* settle;
        expect(replies.labels()).not.toContain("stopped sampler 1");
        expect(replies.labels()).not.toContain("started sampler 2");
        expect(gated.trace).not.toContain("spawning sampler#2");
        yield* gated.release("kill sampler#1");
        yield* eventually(() => replies.labels().includes("started sampler 2"));
        yield* settle;
        const labels = replies.labels();
        expect(labels.filter((entry) => entry === "stopped sampler 1")).toEqual(
          ["stopped sampler 1", "stopped sampler 1"],
        );
        expect(labels.filter((entry) => entry === "started sampler 2")).toEqual(
          ["started sampler 2"],
        );
        expect(gated.trace.indexOf("reaped sampler#1")).toBeGreaterThan(-1);
        expect(gated.trace.indexOf("spawning sampler#2")).toBeGreaterThan(
          gated.trace.indexOf("reaped sampler#1"),
        );
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live(
    "leaves no child alive when the runner closes while a launch is in flight",
    () =>
      Effect.gen(function* () {
        const gated = yield* gatedProcesses;
        const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
          framing(runnerReplySchema),
          framing(runnerRequestSchema),
        );
        const runnerScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(runnerScope, Exit.void));
        yield* runRunner(b, quietOptions).pipe(
          Effect.provide(gated.layer),
          Effect.provideService(Scope.Scope, runnerScope),
          Effect.forkIn(runnerScope),
        );
        yield* gated.hold("spawn sampler#1");
        yield* Effect.addFinalizer(() => gated.release("spawn sampler#1"));
        yield* a.send(request("start", "sampler"));
        yield* eventually(() => gated.trace.includes("spawning sampler#1"));
        const closing = yield* Scope.close(runnerScope, Exit.void).pipe(
          Effect.forkChild,
        );
        yield* settle;
        yield* gated.release("spawn sampler#1");
        yield* Fiber.join(closing).pipe(Effect.timeout("5 seconds"));
        yield* settle;
        expect([...gated.alive]).toEqual([]);
      }).pipe(Effect.scoped),
    10_000,
  );

  it.live(
    "kills a child that finishes launching after the link to the host has closed",
    () =>
      Effect.gen(function* () {
        const gated = yield* gatedProcesses;
        const incoming = yield* Queue.bounded<RunnerRequest, Cause.Done>(16);
        const link: Link<RunnerRequest, RunnerReply> = {
          incoming,
          send: () => Effect.void,
        };
        yield* runRunner(link, quietOptions).pipe(
          Effect.provide(gated.layer),
          Effect.forkScoped,
        );
        yield* gated.hold("spawn sampler#1");
        yield* Effect.addFinalizer(() => gated.release("spawn sampler#1"));
        yield* Queue.offer(incoming, request("start", "sampler"));
        yield* eventually(() => gated.trace.includes("spawning sampler#1"));
        yield* Queue.end(incoming);
        yield* settle;
        yield* gated.release("spawn sampler#1");
        yield* eventually(() => gated.trace.includes("spawned sampler#1"));
        yield* settle;
        expect([...gated.alive]).toEqual([]);
      }).pipe(Effect.scoped),
    10_000,
  );
});
