import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HostError,
  maxPluginLineBytes,
  methods,
  notification,
  type ServerPlugin,
  type SecretReference,
} from "@aphelion/plugin-sdk";
import { runPlugin } from "@aphelion/plugin-sdk/runtime";
import { createTestHost, type Grant } from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { describe } from "vitest";
import { createLogger } from "../log";
import { startFixture } from "./host-fixture";
import { PluginGrants } from "./grants";
import {
  MessageNotSent,
  PluginHost,
  pluginHostLayer,
  RunnerLink,
} from "./host";
import { memoryLinkPair, type Framing } from "./link";
import { PluginProcesses, SpawnFailed, type ProcessExit } from "./processes";
import { runRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

const reference: SecretReference = "op://vault/item/token";

const manifest = {
  id: "contract",
  version: "1.0.0",
  api: "^0.2.0",
  server: { entry: "index.js" },
  permissions: {
    events: ["demo.ping"],
    network: ["api.example.com"],
    secrets: [reference],
  },
};

const grants: readonly Grant[] = [
  { kind: "events", name: "demo.ping" },
  { kind: "network", name: "api.example.com" },
  { kind: "secrets", name: reference },
];

const statusUrl = "https://api.example.com/status";

const attempt = (call: Promise<unknown>) =>
  call.then(
    (result) => ({ result: result ?? null }),
    (error: unknown) => ({
      code: error instanceof HostError ? error.code : undefined,
    }),
  );

function scenario() {
  const outcomes: unknown[] = [];
  const events: unknown[] = [];
  const plugin: ServerPlugin = {
    async start(ctx) {
      const steps = [
        () =>
          ctx.events.subscribe("demo.ping", (data) => {
            events.push(data);
          }),
        () => ctx.events.subscribe("demo.other", () => undefined),
        () => ctx.network.get(statusUrl),
        () => ctx.network.get("https://other.example.com/status"),
        () => ctx.network.get("http://api.example.com/status"),
        () => ctx.secrets.use("refresh", reference),
      ];
      for (const step of steps) outcomes.push(await attempt(step()));
      ctx.log("scenario done");
    },
  };
  return { plugin, outcomes, events };
}

const expectedOutcomes = [
  { result: null },
  { code: -32001 },
  { result: { status: 200, body: "ok" } },
  { code: -32001 },
  { code: -32602 },
  { code: -32002 },
];

function lineChannel() {
  const queued: string[] = [];
  let waiting: ((next: IteratorResult<string, undefined>) => void) | undefined;
  let ended = false;
  return {
    push(line: string) {
      if (waiting) {
        waiting({ done: false, value: line });
        waiting = undefined;
      } else queued.push(line);
    },
    end() {
      ended = true;
      waiting?.({ done: true, value: undefined });
      waiting = undefined;
    },
    input: {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<string, undefined>> => {
          const line = queued.shift();
          if (line !== undefined)
            return Promise.resolve({ done: false, value: line });
          if (ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      }),
    },
  };
}

const sdkProcesses = (plugins: Record<string, ServerPlugin>) =>
  Layer.succeed(PluginProcesses, {
    sweep: Effect.succeed({ survivors: 0 }),
    spawn: (spec) =>
      Effect.gen(function* () {
        const plugin = plugins[spec.plugin];
        if (!plugin)
          return yield* new SpawnFailed({ reason: "no such plugin" });
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exit = yield* Deferred.make<ProcessExit>();
        const stdin = lineChannel();
        const encoder = new TextEncoder();
        const emit = (queue: typeof stdout, text: string) => {
          Effect.runSync(Queue.offer(queue, encoder.encode(`${text}\n`)));
        };
        const finish = (code: number) => {
          Effect.runSync(
            Effect.all([
              Queue.end(stdout),
              Queue.end(stderr),
              Deferred.succeed(exit, { code, signal: null }),
            ]),
          );
        };
        runPlugin(plugin, {
          input: stdin.input,
          write: (line) => {
            emit(stdout, line);
            return Promise.resolve();
          },
          log: (message) => {
            emit(stderr, message);
          },
        }).then(
          () => {
            finish(0);
          },
          () => {
            finish(1);
          },
        );
        return {
          write: (line: string) =>
            Effect.sync(() => {
              stdin.push(line);
            }),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.fromQueue(stderr),
          exited: Deferred.await(exit),
          kill: Effect.sync(() => {
            stdin.end();
          }).pipe(
            Effect.andThen(
              Deferred.succeed(exit, { code: null, signal: "SIGKILL" }),
            ),
            Effect.as({ survivors: 0 }),
          ),
        };
      }),
  });

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

function realHost(plugin: ServerPlugin) {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const runnerLink = Layer.effect(
    RunnerLink,
    Effect.gen(function* () {
      const { a, b } = yield* memoryLinkPair<RunnerReply, RunnerRequest>(
        framing(runnerReplySchema),
        framing(runnerRequestSchema),
      );
      yield* runRunner(b, {
        dataRoot: "/data",
        sweepEvery: "1 hour",
        inputDeadline: "1 second",
        logger,
      }).pipe(
        Effect.provide(sdkProcesses({ [manifest.id]: plugin })),
        Effect.forkScoped,
      );
      return a;
    }),
  );
  const grantsLayer = Layer.succeed(PluginGrants, {
    hasApproval: () => Effect.succeed(true),
    allows: (_approval, permission) =>
      Effect.succeed(
        grants.some(
          (grant) =>
            grant.kind === permission.kind && grant.name === permission.name,
        ),
      ),
  });
  const layer = pluginHostLayer({
    logger,
    network: (url) =>
      url.href === statusUrl
        ? Effect.succeed({ status: 200, body: "ok" })
        : Effect.die(new Error(`unexpected request to ${url.href}`)),
  }).pipe(Layer.provide(runnerLink), Layer.provide(grantsLayer));
  return { layer, logs };
}

const waitUntil = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 600 && !check(); tries++) {
      yield* Effect.sleep("5 millis");
    }
    expect(check()).toBe(true);
  });

describe("an SDK plugin", () => {
  it.live(
    "gets the same answers from the real host as from the test host",
    () => {
      const real = scenario();
      const { layer, logs } = realHost(real.plugin);
      return Effect.gen(function* () {
        const folder = yield* Effect.promise(async () => {
          const created = await mkdtemp(join(tmpdir(), "aphelion-contract-"));
          await writeFile(
            join(created, "aphelion-plugin.json"),
            JSON.stringify(manifest),
          );
          return created;
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(folder, { recursive: true, force: true })),
        );
        const host = yield* PluginHost;
        yield* startFixture(host, folder);
        yield* waitUntil(
          () => real.outcomes.length === expectedOutcomes.length,
        );
        yield* waitUntil(() =>
          logs.some(
            (entry) =>
              entry["msg"] === "plugin wrote to stderr" &&
              entry["line"] === "scenario done",
          ),
        );
        yield* host.publish({ name: "demo.ping", data: { n: 1 } });
        yield* host.publish({ name: "demo.other", data: { n: 2 } });
        yield* waitUntil(() => real.events.length > 0);
        yield* host.stop(manifest.id);
        yield* waitUntil(() =>
          logs.some(
            (entry) =>
              entry["msg"] === "plugin process exited" && entry["code"] === 0,
          ),
        );

        const fake = scenario();
        const testHost = createTestHost(manifest);
        testHost.setGrants(grants);
        testHost.respondToGet(statusUrl, () => ({ status: 200, body: "ok" }));
        yield* Effect.promise(async () => {
          await testHost.start(fake.plugin);
          await testHost.publish("demo.ping", { n: 1 });
          await testHost.publish("demo.other", { n: 2 });
          await testHost.stop();
        });

        expect(real.outcomes).toEqual(expectedOutcomes);
        expect(fake.outcomes).toEqual(expectedOutcomes);
        expect(real.events).toEqual([{ n: 1 }]);
        expect(fake.events).toEqual([{ n: 1 }]);
        expect(testHost.logs).toEqual(["scenario done"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );

  it.live(
    "the real host and the test host agree on the 1 MiB event limit",
    () => {
      const ascii = eventData(maxPluginLineBytes, false);
      const asciiOver = eventData(maxPluginLineBytes + 1, false);
      const multibyte = eventData(maxPluginLineBytes, true);
      const multibyteOver = eventData(maxPluginLineBytes + 1, true);
      const encoder = new TextEncoder();
      for (const [data, bytes] of [
        [ascii, maxPluginLineBytes],
        [asciiOver, maxPluginLineBytes + 1],
        [multibyte, maxPluginLineBytes],
        [multibyteOver, maxPluginLineBytes + 1],
      ] as const) {
        expect(encoder.encode(eventLine(data)).byteLength).toBe(bytes);
      }
      const seen: unknown[] = [];
      const plugin: ServerPlugin = {
        async start(ctx) {
          await ctx.events.subscribe("demo.ping", (data) => {
            seen.push(data);
          });
          ctx.log("subscribed");
        },
      };
      const { layer, logs } = realHost(plugin);
      return Effect.gen(function* () {
        const folder = yield* Effect.promise(async () => {
          const created = await mkdtemp(join(tmpdir(), "aphelion-contract-"));
          await writeFile(
            join(created, "aphelion-plugin.json"),
            JSON.stringify(manifest),
          );
          return created;
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(folder, { recursive: true, force: true })),
        );
        const host = yield* PluginHost;
        yield* startFixture(host, folder);
        yield* waitUntil(() =>
          logs.some((entry) => entry["line"] === "subscribed"),
        );
        yield* host.publish({ name: "demo.ping", data: ascii });
        const asciiRefused = yield* Effect.flip(
          host.publish({ name: "demo.ping", data: asciiOver }),
        );
        yield* host.publish({ name: "demo.ping", data: multibyte });
        const multibyteRefused = yield* Effect.flip(
          host.publish({ name: "demo.ping", data: multibyteOver }),
        );
        yield* waitUntil(() => seen.length === 2);
        expect(asciiRefused).toBeInstanceOf(MessageNotSent);
        expect(asciiRefused).toMatchObject({ reason: "too long" });
        expect(multibyteRefused).toMatchObject({ reason: "too long" });
        expect(seen).toEqual([ascii, multibyte]);

        const fakeSeen: unknown[] = [];
        const testHost = createTestHost(manifest);
        testHost.setGrants(grants);
        yield* Effect.promise(async () => {
          await testHost.start({
            async start(ctx) {
              await ctx.events.subscribe("demo.ping", (data) => {
                fakeSeen.push(data);
              });
            },
          });
          await testHost.publish("demo.ping", ascii);
          await expect(
            testHost.publish("demo.ping", asciiOver),
          ).rejects.toThrow(
            "the event is longer than 1 MiB once encoded, so the host refuses it",
          );
          await testHost.publish("demo.ping", multibyte);
          await expect(
            testHost.publish("demo.ping", multibyteOver),
          ).rejects.toThrow(
            "the event is longer than 1 MiB once encoded, so the host refuses it",
          );
          expect(fakeSeen).toEqual([ascii, multibyte]);
          await testHost.stop();
        });
      }).pipe(Effect.provide(layer), Effect.scoped);
    },
  );
});

function eventLine(data: string): string {
  return JSON.stringify(
    notification(methods.event, { name: "demo.ping", data }),
  );
}

function eventData(target: number, multibyte: boolean): string {
  const extra = target - new TextEncoder().encode(eventLine("")).byteLength;
  if (!multibyte) return "a".repeat(extra);
  const euros = Math.floor(extra / 3);
  const rest = extra % 3;
  return `${"€".repeat(euros)}${rest === 2 ? "é" : rest === 1 ? "a" : ""}`;
}
