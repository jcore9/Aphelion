import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxPluginLineBytes, pluginApiVersion } from "@aphelion/plugin-sdk";
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
import { afterAll, describe } from "vitest";
import { createLogger } from "../log";
import { Secret } from "../secrets";
import { openStore } from "../store";
import { readManifest } from "./manifest-file";
import {
  PluginHost,
  type HostOptions,
  pluginHostLayer,
  RunnerClosed,
  RunnerLink,
} from "./host";
import {
  PluginGrants,
  recordGrants,
  sqlitePluginGrants,
  type Permission,
} from "./grants";
import { rpcErrors } from "./json-rpc";
import type { LifecycleState, RestartPolicy } from "./lifecycle";
import { memoryLinkPair, type Framing } from "./link";
import {
  PluginProcesses,
  SpawnFailed,
  type ProcessExit,
  type SpawnSpec,
} from "./processes";
import {
  maxLogLinesPerMinute,
  runRunner,
  stoppedReading,
  tooMuchLog,
} from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

type Message = Record<string, unknown>;

interface FakeIo {
  readonly env: Readonly<Record<string, string>>;
  readonly read: Effect.Effect<Message>;
  readonly write: (message: Message | string) => Effect.Effect<void>;
  readonly writeError: (text: string) => Effect.Effect<void>;
  readonly call: (method: string, params?: unknown) => Effect.Effect<Message>;
}

type FakePlugin = (io: FakeIo) => Effect.Effect<number>;

function fakeProcesses(
  plugins: Record<string, FakePlugin>,
  deaf: readonly string[],
) {
  const record = {
    spawned: [] as SpawnSpec[],
    received: [] as string[],
    killed: 0,
    timeline: [] as string[],
  };
  const layer = Layer.succeed(PluginProcesses, {
    sweep: Effect.succeed({ survivors: 0 }),
    spawn: (spec) =>
      Effect.gen(function* () {
        record.spawned.push(spec);
        const script = plugins[spec.plugin];
        if (!script)
          return yield* new SpawnFailed({ reason: "no such plugin" });
        const stdin = yield* Queue.unbounded<string>();
        const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exit = yield* Deferred.make<ProcessExit>();
        const encoder = new TextEncoder();
        let nextId = 1000;
        const read = Queue.take(stdin).pipe(
          Effect.map((line) => JSON.parse(line) as Message),
        );
        const write = (message: Message | string) =>
          Queue.offer(
            stdout,
            encoder.encode(
              `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
            ),
          ).pipe(Effect.asVoid);
        const writeError = (text: string) =>
          Queue.offer(stderr, encoder.encode(text)).pipe(Effect.asVoid);
        const call = (method: string, params?: unknown) =>
          Effect.gen(function* () {
            const id = nextId++;
            yield* write({ jsonrpc: "2.0", id, method, params });
            for (;;) {
              const message = yield* read;
              if (message["id"] === id) return message;
            }
          });
        const fiber = yield* script({
          env: spec.env,
          read,
          write,
          writeError,
          call,
        }).pipe(
          Effect.flatMap((code) =>
            Deferred.succeed(exit, { code, signal: null }),
          ),
          Effect.ensuring(Queue.end(stdout)),
          Effect.ensuring(Queue.end(stderr)),
          Effect.forkDetach,
        );
        return {
          write: (line: string) =>
            deaf.includes(spec.plugin)
              ? Effect.never
              : Effect.sync(() => {
                  record.received.push(line);
                  const { method } = JSON.parse(line) as Message;
                  if (typeof method === "string")
                    record.timeline.push(`${spec.plugin} ${method}`);
                }).pipe(
                  Effect.andThen(Queue.offer(stdin, line)),
                  Effect.asVoid,
                ),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.fromQueue(stderr),
          exited: Deferred.await(exit),
          kill: Fiber.interrupt(fiber).pipe(
            Effect.andThen(
              Deferred.succeed(exit, { code: null, signal: "SIGKILL" }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                record.killed++;
                record.timeline.push(`${spec.plugin} killed`);
              }),
            ),
            Effect.as({ survivors: 0 }),
          ),
        };
      }),
  });
  return { layer, record };
}

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxFrameBytes,
  onDrop: () => Effect.void,
});

const fastPolicy: RestartPolicy = {
  handshakeMs: 1_000,
  graceMs: 100,
  firstRetryMs: 20,
  maxCrashes: 3,
  stableMs: 60_000,
};

interface HarnessOptions {
  readonly store?: ReturnType<typeof openStore>;
  readonly network?: HostOptions["network"];
  readonly secretOperations?: HostOptions["secretOperations"];
  readonly grants?: (
    plugin: string,
    permission: Permission,
  ) => boolean | Effect.Effect<boolean>;
  readonly policy?: RestartPolicy;
  readonly deaf?: readonly string[];
  readonly stopDeadlineMs?: number;
}

function harness(
  plugins: Record<string, FakePlugin>,
  options: HarnessOptions = {},
) {
  const fake = fakeProcesses(plugins, options.deaf ?? []);
  const logs: Message[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => logs.push(JSON.parse(line) as Message),
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
        inputDeadline: "50 millis",
        logger,
      }).pipe(Effect.provide(fake.layer), Effect.forkScoped);
      return a;
    }),
  );
  const { grants } = options;
  const grantsLayer = grants
    ? Layer.succeed(PluginGrants, {
        allows: (plugin, permission) => {
          const allowed = grants(plugin, permission);
          return typeof allowed === "boolean"
            ? Effect.succeed(allowed)
            : allowed;
        },
      })
    : options.store
      ? sqlitePluginGrants(options.store)
      : PluginGrants.refuseAll;
  const layer = pluginHostLayer({
    logger,
    policy: options.policy ?? fastPolicy,
    ...(options.network && { network: options.network }),
    ...(options.secretOperations && {
      secretOperations: options.secretOperations,
    }),
    ...(options.stopDeadlineMs && { stopDeadlineMs: options.stopDeadlineMs }),
  }).pipe(Layer.provide(runnerLink), Layer.provide(grantsLayer));
  return { layer, record: fake.record, logs };
}

const allowAll = () => true;

let base: string | undefined;
afterAll(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

async function pluginFolder(manifest: Message): Promise<string> {
  base ??= await mkdtemp(join(tmpdir(), "aphelion-host-"));
  const folder = join(base, `${String(manifest["id"])}-${crypto.randomUUID()}`);
  await mkdir(folder);
  await writeFile(
    join(folder, "aphelion-plugin.json"),
    JSON.stringify(manifest),
  );
  return folder;
}

const serverPlugin = (id: string, permissions: Message = {}) =>
  Effect.promise(() =>
    pluginFolder({
      id,
      version: "1.0.0",
      api: "^0.2.0",
      server: { entry: "index.js" },
      permissions,
    }),
  );

const handshake = (io: FakeIo) =>
  Effect.gen(function* () {
    const init = yield* io.read;
    yield* io.write({ jsonrpc: "2.0", id: init["id"] as number, result: {} });
    return init;
  });

const serveUntilShutdown = (io: FakeIo) =>
  Effect.gen(function* () {
    for (;;) {
      const message = yield* io.read;
      if (message["method"] === "shutdown") return 0;
    }
  });

const waitFor = (id: string, wanted: Partial<Record<string, unknown>>) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    const matches = (state: LifecycleState | undefined) => {
      const fields: Record<string, unknown> = { ...state };
      return (
        state !== undefined &&
        Object.entries(wanted).every(([key, value]) => fields[key] === value)
      );
    };
    for (let tries = 0; tries < 600; tries++) {
      const state = yield* host.status(id);
      if (matches(state)) return state;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`${id} is ${JSON.stringify(yield* host.status(id))}`),
    );
  });

const waitUntil = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 600 && !check(); tries++) {
      yield* Effect.sleep("5 millis");
    }
    expect(check()).toBe(true);
  });

describe("the plugin host", () => {
  it.live(
    "starts a plugin with a minimal environment and runs it after the handshake",
    () => {
      let init: Message | undefined;
      const { layer, record } = harness({
        weather: (io) =>
          Effect.gen(function* () {
            init = yield* handshake(io);
            return yield* serveUntilShutdown(io);
          }),
      });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        const folder = yield* serverPlugin("weather");
        expect(yield* host.start(folder)).toEqual({
          kind: "starting",
          id: "weather",
        });
        yield* waitFor("weather", { state: "running", run: 1 });
        expect(init).toMatchObject({
          method: "initialize",
          params: { api: pluginApiVersion, plugin: "weather" },
        });
        expect(record.spawned).toEqual([
          {
            plugin: "weather",
            folder,
            entry: "index.js",
            dataFolder: "/data/weather",
            env: {
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: "/data/weather",
              LANG: "C.UTF-8",
              APHELION_PLUGIN_ID: "weather",
              APHELION_PLUGIN_DATA: "/data/weather",
            },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "refuses a plugin outside the host's API range before starting it",
    () => {
      const { layer, record } = harness({ old: () => Effect.succeed(0) });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        const folder = yield* Effect.promise(() =>
          pluginFolder({
            id: "old",
            version: "1.0.0",
            api: "^0.1.0",
            server: { entry: "index.js" },
          }),
        );
        const refused = yield* Effect.flip(host.start(folder));
        expect(refused._tag).toBe("PluginRefused");
        expect(refused.issues).toEqual([
          {
            field: "api",
            message: `doesn't include plugin API ${pluginApiVersion}, which this host runs`,
          },
        ]);
        expect(yield* host.status("old")).toBeUndefined();
        expect(record.spawned).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("refuses a folder without a readable manifest", () => {
    const { layer } = harness({});
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      const empty = yield* Effect.promise(() =>
        mkdtemp(join(tmpdir(), "aphelion-empty-")),
      );
      const refused = yield* Effect.flip(host.start(empty));
      expect(refused.issues).toEqual([
        { message: "can't read aphelion-plugin.json" },
      ]);
      yield* Effect.promise(() => rm(empty, { recursive: true }));
    }).pipe(Effect.provide(layer));
  });

  it.live("starts nothing for a plugin with only a client part", () => {
    const { layer, record } = harness({});
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      const folder = yield* Effect.promise(() =>
        pluginFolder({
          id: "avatar",
          version: "1.0.0",
          api: "^0.2.0",
          client: { entry: "ui.js" },
        }),
      );
      expect(yield* host.start(folder)).toEqual({
        kind: "client only",
        id: "avatar",
      });
      expect(yield* host.status("avatar")).toBeUndefined();
      expect(record.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("restarts a plugin that crashed, after a delay", () => {
    let runs = 0;
    const { layer, record, logs } = harness({
      flaky: (io) =>
        Effect.gen(function* () {
          runs++;
          yield* handshake(io);
          if (runs === 1) return 1;
          return yield* serveUntilShutdown(io);
        }),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("flaky"));
      yield* waitFor("flaky", { state: "running", run: 2 });
      expect(record.spawned).toHaveLength(2);
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: "plugin state changed",
          plugin: "flaky",
          to: "crashed",
          run: 1,
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "starts an approved plugin only while its manifest matches the approval",
    () => {
      let folder = "";
      const { layer, record, logs } = harness({
        pinned: (io) =>
          Effect.gen(function* () {
            yield* handshake(io);
            yield* Effect.promise(() =>
              writeFile(
                join(folder, "aphelion-plugin.json"),
                JSON.stringify({
                  id: "pinned",
                  version: "1.0.1",
                  api: "^0.2.0",
                  server: { entry: "index.js" },
                  permissions: {},
                }),
              ),
            );
            return 1;
          }),
      });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        folder = yield* serverPlugin("pinned");
        const { digest } = yield* readManifest(folder);

        const refused = yield* Effect.flip(
          host.start(folder, { id: "pinned", digest: "0".repeat(64) }),
        );
        expect(refused.issues[0]?.message).toContain(
          "the manifest changed since it was approved",
        );
        expect(record.spawned).toEqual([]);

        yield* host.start(folder, { id: "pinned", digest });
        yield* waitFor("pinned", { state: "stopped" });
        expect(record.spawned).toHaveLength(1);
        expect(logs).toContainEqual(
          expect.objectContaining({
            msg: "a plugin's manifest changed since it was approved, so it won't start",
            plugin: "pinned",
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("gives up on a plugin that keeps crashing", () => {
    const { layer, record } = harness({
      broken: (io) => handshake(io).pipe(Effect.as(1)),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("broken"));
      yield* waitFor("broken", {
        state: "stopped",
        reason: "crashed too often",
      });
      expect(record.spawned).toHaveLength(fastPolicy.maxCrashes + 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("kills a hung plugin when the handshake times out", () => {
    const { layer, record } = harness(
      { hung: () => Effect.never },
      { policy: { ...fastPolicy, handshakeMs: 50 } },
    );
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("hung"));
      yield* waitFor("hung", { state: "crashed", run: 1 });
      yield* waitUntil(() => record.killed >= 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("stops a plugin that exits when asked", () => {
    const { layer, record } = harness({
      polite: (io) =>
        handshake(io).pipe(Effect.andThen(serveUntilShutdown(io))),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("polite"));
      yield* waitFor("polite", { state: "running" });
      yield* host.stop("polite");
      yield* waitFor("polite", { state: "stopped", reason: "requested" });
      expect(record.killed).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "kills a plugin that ignores the shutdown after the grace time",
    () => {
      const { layer, record } = harness({
        stubborn: (io) =>
          handshake(io).pipe(Effect.andThen(Effect.forever(io.read))),
      });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(yield* serverPlugin("stubborn"));
        yield* waitFor("stubborn", { state: "running" });
        yield* host.stop("stubborn");
        yield* waitFor("stubborn", { state: "stopped", reason: "requested" });
        expect(record.killed).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "finishes stopping before stop returns, so a start right after it runs again",
    () => {
      const { layer, record } = harness({
        stubborn: (io) =>
          handshake(io).pipe(Effect.andThen(Effect.forever(io.read))),
      });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        const folder = yield* serverPlugin("stubborn");
        yield* host.start(folder);
        yield* waitFor("stubborn", { state: "running", run: 1 });
        yield* host.stop("stubborn");
        expect(yield* host.status("stubborn")).toEqual({
          state: "stopped",
          run: 1,
          reason: "requested",
        });
        expect(record.killed).toBe(1);
        yield* host.start(folder);
        const state = yield* host.waitFor(
          "stubborn",
          (state) => state.state === "running",
        );
        expect(state).toMatchObject({ state: "running", run: 2 });
        expect(record.spawned).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("stop returns, and waits fail, once the runner's pipe closes", () =>
    Effect.gen(function* () {
      const incoming = yield* Queue.bounded<RunnerReply, Cause.Done>(16);
      const layer = pluginHostLayer({
        logger: createLogger({ level: "error", write: () => undefined }),
      }).pipe(
        Layer.provide(
          Layer.succeed(RunnerLink, { incoming, send: () => Effect.void }),
        ),
        Layer.provide(PluginGrants.refuseAll),
      );
      yield* Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(yield* serverPlugin("orphan"));
        const stopping = yield* Effect.forkChild(host.stop("orphan"));
        yield* Effect.sleep("50 millis");
        yield* Queue.end(incoming);
        yield* Fiber.join(stopping).pipe(Effect.timeout("2 seconds"));
        const waited = yield* Effect.flip(host.waitFor("orphan", () => false));
        expect(waited).toBeInstanceOf(RunnerClosed);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.live("returns at once when stopping a plugin that isn't running", () => {
    const { layer } = harness({ quitter: () => Effect.succeed(1) });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.stop("unknown");
      yield* host.start(yield* serverPlugin("quitter"));
      yield* waitFor("quitter", { state: "stopped" });
      yield* host.stop("quitter");
      expect(yield* host.status("quitter")).toMatchObject({
        state: "stopped",
        reason: "crashed too often",
      });
      expect(yield* host.waitFor("unknown", () => true)).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "answers malformed JSON-RPC with an error and keeps the plugin running",
    () => {
      const replies: Message[] = [];
      const { layer } = harness({
        sloppy: (io) =>
          Effect.gen(function* () {
            yield* handshake(io);
            yield* io.write("this is not json");
            replies.push(yield* io.read);
            yield* io.write({ jsonrpc: "2.0", id: 5 });
            replies.push(yield* io.read);
            replies.push(yield* io.call("no.such.method"));
            return yield* serveUntilShutdown(io);
          }),
      });
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(yield* serverPlugin("sloppy"));
        yield* waitUntil(() => replies.length === 3);
        expect(replies).toEqual([
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          },
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid request" },
          },
          {
            jsonrpc: "2.0",
            id: 1000,
            error: { code: -32601, message: "Method not found" },
          },
        ]);
        expect(yield* host.status("sloppy")).toMatchObject({
          state: "running",
          run: 1,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "delivers only events the manifest declares and the grants allow",
    () => {
      const replies: Message[] = [];
      const events: Message[] = [];
      const { layer } = harness(
        {
          watcher: (io) =>
            Effect.gen(function* () {
              yield* handshake(io);
              for (const event of ["bot.status", "chat.message", "tool.call"]) {
                replies.push(yield* io.call("events.subscribe", { event }));
              }
              for (;;) {
                const message = yield* io.read;
                if (message["method"] === "event") events.push(message);
              }
            }),
        },
        {
          grants: (_, permission) => permission.name === "bot.status",
        },
      );
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(
          yield* serverPlugin("watcher", {
            events: ["bot.status", "chat.message"],
          }),
        );
        yield* waitUntil(() => replies.length === 3);
        expect(
          replies.map((reply) => reply["result"] ?? reply["error"]),
        ).toEqual([
          {},
          { code: -32001, message: "Not granted" },
          { code: -32001, message: "Not granted" },
        ]);
        for (const name of ["chat.message", "tool.call", "bot.status"]) {
          yield* host.publish({ name, data: { busy: true } });
        }
        yield* waitUntil(() => events.length === 1);
        yield* Effect.sleep("20 millis");
        expect(events).toEqual([
          {
            jsonrpc: "2.0",
            method: "event",
            params: { name: "bot.status", data: { busy: true } },
          },
        ]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("refuses every event by default, until grants exist", () => {
    let reply: Message | undefined;
    const { layer } = harness({
      watcher: (io) =>
        Effect.gen(function* () {
          yield* handshake(io);
          reply = yield* io.call("events.subscribe", { event: "bot.status" });
          return yield* serveUntilShutdown(io);
        }),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(
        yield* serverPlugin("watcher", { events: ["bot.status"] }),
      );
      yield* waitUntil(() => reply !== undefined);
      expect(reply?.["error"]).toEqual({
        code: -32001,
        message: "Not granted",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "checks SQLite grants per plugin before proxying a request or using a secret",
    () =>
      Effect.gen(function* () {
        const folder = yield* serverPlugin("keyring", {
          network: ["api.example.com", "other.example.com"],
          events: ["bot.status", "chat.message"],
          secrets: ["op://vault/item/field"],
        });
        const sibling = yield* serverPlugin("sibling", {
          network: ["api.example.com"],
        });
        const installation = yield* readManifest(folder);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => openStore(join(folder, "grants.db"))),
          (db) =>
            Effect.sync(() => {
              recordGrants(db, { ...installation, folder }, [
                { kind: "network", name: "api.example.com" },
                { kind: "events", name: "bot.status" },
                { kind: "secrets", name: "op://vault/item/field" },
              ]);
            }),
          (db) =>
            Effect.sync(() => {
              db.close();
            }),
        );
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => openStore(join(folder, "grants.db"))),
          (db) =>
            Effect.sync(() => {
              db.close();
            }),
        );
        const replies: Message[] = [];
        const siblingReplies: Message[] = [];
        const urls: string[] = [];
        const events: Message[] = [];
        const operations: string[] = [];
        const url = "https://api.example.com/item";
        const reference = "op://vault/item/field";
        const { layer } = harness(
          {
            keyring: (io) =>
              Effect.gen(function* () {
                yield* handshake(io);
                for (const event of ["bot.status", "chat.message"]) {
                  replies.push(yield* io.call("events.subscribe", { event }));
                }
                replies.push(yield* io.call("network.get", { url }));
                replies.push(
                  yield* io.call("network.get", {
                    url: "https://other.example.com/item",
                  }),
                );
                replies.push(
                  yield* io.call("secrets.use", {
                    reference,
                    operation: "refresh",
                  }),
                );
                replies.push(
                  yield* io.call("secrets.use", {
                    reference: "op://vault/other/field",
                    operation: "refresh",
                  }),
                );
                replies.push(yield* io.call("secrets.get", { reference }));
                for (;;) {
                  const message = yield* io.read;
                  if (message["method"] === "event") events.push(message);
                }
              }),
            sibling: (io) =>
              Effect.gen(function* () {
                yield* handshake(io);
                siblingReplies.push(yield* io.call("network.get", { url }));
                return yield* serveUntilShutdown(io);
              }),
          },
          {
            store: db,
            network: (target) =>
              Effect.sync(() => {
                urls.push(target.href);
                return { status: 200, body: "ok" };
              }),
            secretOperations: new Map([
              [
                "refresh",
                {
                  reference,
                  host: "api.example.com",
                  run: (plugin) =>
                    Effect.sync(() => {
                      operations.push(plugin);
                    }),
                },
              ],
            ]),
          },
        );
        yield* Effect.gen(function* () {
          const host = yield* PluginHost;
          yield* host.start(folder);
          yield* host.start(sibling);
          yield* waitUntil(
            () => replies.length === 7 && siblingReplies.length === 1,
          );
          expect(
            replies.map((reply) => reply["result"] ?? reply["error"]),
          ).toEqual([
            {},
            rpcErrors.notGranted,
            { status: 200, body: "ok" },
            rpcErrors.notGranted,
            {},
            rpcErrors.notGranted,
            rpcErrors.methodNotFound,
          ]);
          expect(siblingReplies[0]?.["error"]).toEqual(rpcErrors.notGranted);
          expect(urls).toEqual([url]);
          expect(operations).toEqual(["keyring"]);
          yield* host.publish({ name: "chat.message", data: {} });
          yield* host.publish({ name: "bot.status", data: {} });
          yield* waitUntil(() => events.length === 1);
          expect(events[0]?.["params"]).toEqual({
            name: "bot.status",
            data: {},
          });
          recordGrants(db, { ...installation, folder }, []);
          yield* host.publish({ name: "bot.status", data: {} });
          yield* Effect.sleep("20 millis");
          expect(events).toHaveLength(1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.live(
    "cancels an in-flight operation on stop and never starts queued work",
    () => {
      const calls: string[] = [];
      const replies: Message[] = [];
      const cleanupStarted = Deferred.makeUnsafe<undefined>();
      const releaseCleanup = Deferred.makeUnsafe<undefined>();
      let canceled = false;
      const { layer } = harness(
        {
          watcher: (io) =>
            Effect.gen(function* () {
              yield* io.write({
                jsonrpc: "2.0",
                id: 42,
                method: "network.get",
                params: {
                  url: "https://api.example.com/before-initialize",
                },
              });
              yield* handshake(io);
              replies.push(yield* io.read);
              yield* io.write({
                jsonrpc: "2.0",
                id: 43,
                method: "network.get",
                params: {
                  url: "https://api.example.com/first",
                },
              });
              yield* waitUntil(() => calls.length === 1);
              replies.push(
                yield* io.call("network.get", {
                  url: "https://api.example.com/second",
                }),
              );
              return yield* serveUntilShutdown(io);
            }),
        },
        {
          grants: allowAll,
          network: (url) =>
            Effect.sync(() => {
              calls.push(url.pathname);
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleanupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCleanup)),
                  Effect.andThen(
                    Effect.sync(() => {
                      canceled = true;
                    }),
                  ),
                ),
              ),
            ),
        },
      );

      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(
          yield* serverPlugin("watcher", { network: ["api.example.com"] }),
        );
        yield* waitUntil(() => replies.length === 2);
        expect(replies.map((reply) => reply["error"])).toEqual([
          rpcErrors.notGranted,
          rpcErrors.busy,
        ]);
        yield* host.stop("watcher");
        yield* Deferred.await(cleanupStarted);
        yield* waitFor("watcher", { state: "stopped", reason: "requested" });
        expect(calls).toEqual(["/first"]);
        expect(canceled).toBe(false);
        yield* Deferred.succeed(releaseCleanup, undefined);
        yield* waitUntil(() => canceled);
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)),
        Effect.provide(layer),
      );
    },
  );

  it.live(
    "does not reuse the previous manifest's grants after an automatic restart",
    () =>
      Effect.gen(function* () {
        const folder = yield* serverPlugin("watcher", {
          events: ["bot.status"],
        });
        const file = join(folder, "aphelion-plugin.json");
        const original = yield* Effect.promise(() => readFile(file, "utf8"));
        const installation = yield* readManifest(folder);
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => openStore(join(folder, "grants.db"))),
          (store) =>
            Effect.sync(() => {
              store.close();
            }),
        );
        recordGrants(db, installation, [
          { kind: "events", name: "bot.status" },
        ]);
        const replies: Message[] = [];
        const { layer } = harness(
          {
            watcher: (io) =>
              Effect.gen(function* () {
                yield* handshake(io);
                replies.push(
                  yield* io.call("events.subscribe", { event: "bot.status" }),
                );
                if (replies.length === 1) {
                  yield* Effect.promise(() =>
                    writeFile(file, original.replace("1.0.0", "1.0.1")),
                  );
                  return 1;
                }
                return yield* serveUntilShutdown(io);
              }),
          },
          { store: db },
        );
        yield* Effect.gen(function* () {
          const host = yield* PluginHost;
          yield* host.start(folder);
          yield* waitUntil(() => replies.length === 2);
          expect(replies[0]?.["result"]).toEqual({});
          expect(replies[1]?.["error"]).toEqual(rpcErrors.notGranted);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );

  it.live("never serializes a secret value or offers a secret read API", () => {
    const canary = `canary-${crypto.randomUUID()}`;
    const replies: Message[] = [];
    const { layer, record } = harness(
      {
        keyring: (io) =>
          Effect.gen(function* () {
            yield* handshake(io);
            const params = {
              reference: "op://vault/item/field",
              operation: "refresh",
            };
            replies.push(yield* io.call("secrets.use", params));
            replies.push(yield* io.call("secrets.get", params));
            return yield* serveUntilShutdown(io);
          }),
      },
      { grants: allowAll },
    );
    return Effect.gen(function* () {
      process.env["APHELION_CANARY"] = canary;
      const host = yield* PluginHost;
      yield* host.start(
        yield* serverPlugin("keyring", {
          secrets: ["op://vault/item/field"],
          network: ["api.example.com"],
          events: ["bot.status"],
        }),
      );
      yield* waitUntil(() => replies.length === 2);
      expect(replies.map((reply) => reply["error"])).toEqual([
        rpcErrors.noSecretOperations,
        rpcErrors.methodNotFound,
      ]);
      const secret = Secret.make(canary);
      const refused = yield* Effect.flip(
        host.publish({ name: "bot.status", data: { secret } }),
      );
      expect(refused).toMatchObject({
        _tag: "MessageNotSent",
        reason: "not serializable",
      });
      const seen = JSON.stringify([record.spawned, record.received]);
      expect(seen).toContain("-32002");
      expect(seen).not.toContain(canary);
    }).pipe(
      Effect.ensuring(Effect.sync(() => delete process.env["APHELION_CANARY"])),
      Effect.provide(layer),
    );
  });

  it.live(
    "doesn't hand an event checked for one run to the run that replaced it",
    () => {
      const events: Message[] = [];
      let runs = 0;
      let subscribed = false;
      let checking = false;
      let gate: Deferred.Deferred<boolean> | undefined;
      const { layer } = harness(
        {
          racer: (io) =>
            Effect.gen(function* () {
              const run = ++runs;
              yield* handshake(io);
              if (run === 1) {
                yield* io.call("events.subscribe", { event: "bot.status" });
                subscribed = true;
              }
              for (;;) {
                const message = yield* io.read;
                if (message["method"] === "shutdown") return 0;
                if (message["method"] === "event")
                  events.push({ run, message });
              }
            }),
        },
        {
          grants: () => {
            if (gate === undefined) return true;
            checking = true;
            return Deferred.await(gate);
          },
        },
      );
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        const folder = yield* serverPlugin("racer", {
          events: ["bot.status"],
        });
        yield* host.start(folder);
        yield* waitUntil(() => subscribed);
        const opened = yield* Deferred.make<boolean>();
        gate = opened;
        const publishing = yield* Effect.forkChild(
          host.publish({ name: "bot.status", data: {} }),
        );
        yield* waitUntil(() => checking);
        yield* host.stop("racer");
        yield* waitFor("racer", { state: "stopped" });
        yield* host.start(folder);
        yield* waitFor("racer", { state: "running", run: 2 });
        yield* Deferred.succeed(opened, true);
        yield* Fiber.join(publishing);
        yield* Effect.sleep("50 millis");
        expect(events).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "keeps stopping other plugins while one plugin doesn't read its input",
    () => {
      const { layer, record, logs } = harness(
        {
          deaf: () => Effect.never,
          polite: (io) =>
            handshake(io).pipe(Effect.andThen(serveUntilShutdown(io))),
        },
        { deaf: ["deaf"], policy: { ...fastPolicy, handshakeMs: 60_000 } },
      );
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(yield* serverPlugin("polite"));
        yield* waitFor("polite", { state: "running" });
        yield* host.start(yield* serverPlugin("deaf"));
        yield* waitUntil(() =>
          record.spawned.some((spec) => spec.plugin === "deaf"),
        );
        yield* Effect.sleep("10 millis");
        yield* host.stop("polite");
        yield* waitFor("polite", { state: "stopped", reason: "requested" });
        yield* waitUntil(() =>
          logs.some(
            (log) => log["plugin"] === "deaf" && log["line"] === stoppedReading,
          ),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "crashes a plugin that sends messages faster than the host handles them",
    () => {
      const { layer, logs } = harness(
        {
          flood: (io) =>
            Effect.gen(function* () {
              yield* handshake(io);
              yield* io.write({
                jsonrpc: "2.0",
                id: 1,
                method: "events.subscribe",
                params: { event: "bot.status" },
              });
              const padding = "x".repeat(maxPluginLineBytes - 100);
              for (let i = 0; i < 20; i++) {
                yield* io.write({
                  jsonrpc: "2.0",
                  method: "note",
                  params: [padding],
                });
              }
              return yield* serveUntilShutdown(io);
            }),
        },
        { grants: () => Effect.sleep("300 millis").pipe(Effect.as(true)) },
      );
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(
          yield* serverPlugin("flood", { events: ["bot.status"] }),
        );
        yield* waitFor("flood", { state: "crashed", run: 1 });
        expect(logs).toContainEqual(
          expect.objectContaining({
            msg: "plugin sent messages faster than the host handles them",
            plugin: "flood",
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "crashes a plugin that floods the host with many short messages",
    () => {
      const { layer, logs } = harness(
        {
          chatter: (io) =>
            Effect.gen(function* () {
              yield* handshake(io);
              yield* io.write({
                jsonrpc: "2.0",
                id: 1,
                method: "events.subscribe",
                params: { event: "bot.status" },
              });
              for (let i = 0; i < 5000; i++) {
                yield* io.write({ jsonrpc: "2.0", method: "note" });
              }
              return yield* serveUntilShutdown(io);
            }),
        },
        { grants: () => Effect.sleep("300 millis").pipe(Effect.as(true)) },
      );
      return Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.start(
          yield* serverPlugin("chatter", { events: ["bot.status"] }),
        );
        yield* waitFor("chatter", { state: "crashed", run: 1 });
        expect(logs).toContainEqual(
          expect.objectContaining({
            msg: "plugin sent messages faster than the host handles them",
            plugin: "chatter",
          }),
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("logs at most 1000 lines a minute from a plugin's stderr", () => {
    const { layer, logs } = harness({
      chatty: (io) =>
        Effect.gen(function* () {
          yield* handshake(io);
          yield* io.writeError("line\n".repeat(maxLogLinesPerMinute + 50));
          return yield* serveUntilShutdown(io);
        }),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("chatty"));
      yield* waitUntil(() => logs.some((log) => log["line"] === tooMuchLog));
      yield* Effect.sleep("20 millis");
      expect(
        logs.filter((log) => log["msg"] === "plugin wrote to stderr"),
      ).toHaveLength(maxLogLinesPerMinute + 1);
    }).pipe(Effect.provide(layer));
  });

  it.live("counts dropped long lines against the same log limit", () => {
    const { layer, logs } = harness({
      sprawling: (io) =>
        Effect.gen(function* () {
          yield* handshake(io);
          yield* io.writeError("line\n".repeat(maxLogLinesPerMinute - 1));
          for (let i = 0; i < 5; i++) {
            yield* io.write("x".repeat(maxPluginLineBytes + 1));
          }
          return yield* serveUntilShutdown(io);
        }),
    });
    return Effect.gen(function* () {
      const host = yield* PluginHost;
      yield* host.start(yield* serverPlugin("sprawling"));
      yield* waitUntil(() => logs.some((log) => log["line"] === tooMuchLog));
      yield* Effect.sleep("20 millis");
      expect(
        logs.filter((log) => log["msg"] === "plugin wrote to stderr"),
      ).toHaveLength(maxLogLinesPerMinute + 1);
    }).pipe(Effect.provide(layer));
  });
});

const openHost = (layer: Layer.Layer<PluginHost>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layer, scope);
    const close = Effect.gen(function* () {
      const begun = Date.now();
      yield* Scope.close(scope, Exit.void);
      return Date.now() - begun;
    });
    return { host: Context.get(context, PluginHost), close };
  });

const isRunning = (state: LifecycleState) => state.state === "running";

describe("the plugin host, when it closes", () => {
  it.live(
    "sends shutdown to every plugin before it kills any, and kills only the ones that don't exit",
    () => {
      const { layer, record, logs } = harness(
        {
          polite: (io) =>
            handshake(io).pipe(Effect.andThen(serveUntilShutdown(io))),
          stubborn: (io) =>
            handshake(io).pipe(Effect.andThen(Effect.forever(io.read))),
        },
        { policy: { ...fastPolicy, graceMs: 200 } },
      );
      return Effect.gen(function* () {
        const { host, close } = yield* openHost(layer);
        yield* host.start(yield* serverPlugin("polite"));
        yield* host.start(yield* serverPlugin("stubborn"));
        yield* host.waitFor("polite", isRunning);
        yield* host.waitFor("stubborn", isRunning);
        const elapsed = yield* close;
        const stops = record.timeline.filter(
          (entry) => !entry.endsWith("initialize"),
        );
        expect(stops.slice(0, 2).sort()).toEqual([
          "polite shutdown",
          "stubborn shutdown",
        ]);
        expect(stops.slice(2)).toEqual(["stubborn killed"]);
        expect(elapsed).toBeGreaterThanOrEqual(190);
        expect(elapsed).toBeLessThan(2000);
        expect(logs).toContainEqual(
          expect.objectContaining({
            msg: "the plugin host is stopping every plugin",
            plugins: 2,
          }),
        );
      });
    },
  );

  for (const runner of ["never confirms a kill", "stops reading"] as const) {
    it.live(`returns within the stop deadline when the runner ${runner}`, () =>
      Effect.gen(function* () {
        const incoming = yield* Queue.bounded<RunnerReply, Cause.Done>(64);
        const sent: RunnerRequest[] = [];
        let reading = true;
        const reply = (message: RunnerReply) =>
          Queue.offer(incoming, message).pipe(Effect.asVoid);
        const send = (request: RunnerRequest) =>
          Effect.suspend(() => {
            if (!reading) return Effect.never;
            sent.push(request);
            const { plugin, run } = request;
            if (request.type === "start")
              return reply({ type: "started", plugin, run });
            if (request.type !== "input") return Effect.void;
            const message = JSON.parse(request.line) as Message;
            if (message["method"] === "shutdown" && runner === "stops reading")
              reading = false;
            if (message["method"] !== "initialize") return Effect.void;
            return reply({
              type: "output",
              plugin,
              run,
              line: JSON.stringify({
                jsonrpc: "2.0",
                id: message["id"],
                result: {},
              }),
            });
          });
        const logs: Message[] = [];
        const layer = pluginHostLayer({
          logger: createLogger({
            level: "debug",
            write: (line) => logs.push(JSON.parse(line) as Message),
          }),
          policy: { ...fastPolicy, graceMs: 100 },
          stopDeadlineMs: 500,
        }).pipe(
          Layer.provide(Layer.succeed(RunnerLink, { incoming, send })),
          Layer.provide(PluginGrants.refuseAll),
        );
        const { host, close } = yield* openHost(layer);
        const ids = ["first", "second", "third"];
        for (const id of ids) {
          yield* host.start(yield* serverPlugin(id));
          yield* host.waitFor(id, isRunning);
        }
        const elapsed = yield* close;
        expect(elapsed).toBeGreaterThanOrEqual(440);
        expect(elapsed).toBeLessThan(1400);
        if (runner === "never confirms a kill") {
          expect(logs).toContainEqual(
            expect.objectContaining({
              msg: "plugins were still running at the stop deadline, so the host told the runner to kill them",
              plugins: ids,
            }),
          );
        }
      }),
    );
  }

  it.live(
    "relaunches neither a crashed plugin nor one started during the stop",
    () => {
      let flakyRuns = 0;
      const { layer, record, logs } = harness(
        {
          stubborn: (io) =>
            handshake(io).pipe(Effect.andThen(Effect.forever(io.read))),
          flaky: (io) =>
            Effect.sync(() => flakyRuns++).pipe(
              Effect.andThen(handshake(io)),
              Effect.as(1),
            ),
          late: (io) =>
            handshake(io).pipe(Effect.andThen(serveUntilShutdown(io))),
        },
        { policy: { ...fastPolicy, graceMs: 400, firstRetryMs: 150 } },
      );
      return Effect.gen(function* () {
        const { host, close } = yield* openHost(layer);
        const late = yield* serverPlugin("late");
        yield* host.start(yield* serverPlugin("stubborn"));
        yield* host.waitFor("stubborn", isRunning);
        yield* host.start(yield* serverPlugin("flaky"));
        yield* host.waitFor("flaky", (state) => state.state === "crashed");
        const starting = yield* Effect.forkChild(
          waitUntil(() =>
            logs.some(
              (entry) =>
                entry["msg"] === "the plugin host is stopping every plugin",
            ),
          ).pipe(Effect.andThen(host.start(late))),
        );
        const elapsed = yield* close;
        yield* Fiber.join(starting);
        expect(elapsed).toBeGreaterThanOrEqual(390);
        expect(flakyRuns).toBe(1);
        expect(record.spawned.map((spec) => spec.plugin)).toEqual([
          "stubborn",
          "flaky",
        ]);
        expect(yield* host.status("flaky")).toMatchObject({ state: "stopped" });
        expect(yield* host.status("late")).toMatchObject({
          state: "installed",
        });
      });
    },
  );
});
