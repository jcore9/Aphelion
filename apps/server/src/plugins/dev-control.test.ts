import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Queue, Scope } from "effect";
import { afterAll, beforeAll, describe } from "vitest";
import { createLogger } from "../log";
import {
  devControl,
  serveDevSocket,
  type DevReply,
  type DevResult,
} from "./dev-control";
import type { Installed } from "./grants";
import { PluginHost, pluginHostLayer, RunnerLink } from "./host";
import { defaultRestartPolicy, type RestartPolicy } from "./lifecycle";
import { PluginGrants } from "./grants";
import { readManifest } from "./manifest-file";
import type { RunnerReply, RunnerRequest } from "./runner-protocol";

const logger = createLogger({ level: "error", write: () => undefined });

function fakeRunner(exitAfterReady: boolean) {
  const starts: number[] = [];
  let reply: (message: RunnerReply) => Effect.Effect<void> = () =>
    Effect.die("the fake runner hasn't started");
  const exit = (plugin: string, run: number) =>
    Effect.suspend(() =>
      reply({ type: "exited", plugin, run, code: 1, signal: null }),
    );
  const layer = Layer.effect(
    RunnerLink,
    Effect.gen(function* () {
      const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
      reply = (message: RunnerReply) =>
        Queue.offer(incoming, message).pipe(Effect.asVoid);
      return {
        incoming,
        send: (request: RunnerRequest) =>
          Effect.gen(function* () {
            const { plugin, run } = request;
            switch (request.type) {
              case "start":
                starts.push(run);
                return yield* reply({ type: "started", plugin, run });
              case "stop":
                return yield* reply({ type: "stopped", plugin, run });
              case "input": {
                const message = JSON.parse(request.line) as {
                  id?: number;
                  method?: string;
                };
                if (message.method === "initialize") {
                  const line = JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {},
                  });
                  yield* reply({ type: "output", plugin, run, line });
                  if (exitAfterReady) {
                    return yield* reply({
                      type: "exited",
                      plugin,
                      run,
                      code: 1,
                      signal: null,
                    });
                  }
                  return;
                }
                if (message.method === "shutdown") {
                  return yield* reply({
                    type: "exited",
                    plugin,
                    run,
                    code: 0,
                    signal: null,
                  });
                }
              }
            }
          }),
      };
    }),
  );
  return { layer, starts, exit };
}

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "aphelion-dev-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const manifest = (version: string) =>
  JSON.stringify({
    id: "weather",
    version,
    api: "^0.2.0",
    server: { entry: "index.js" },
    permissions: {},
  });

const setup = Effect.gen(function* () {
  const root = yield* Effect.promise(() => mkdtemp(join(base, "case-")));
  const folder = join(root, "dev-plugin");
  const other = join(root, "other-plugin");
  yield* Effect.promise(async () => {
    for (const path of [folder, other]) {
      await mkdir(path);
      await writeFile(join(path, "aphelion-plugin.json"), manifest("1.0.0"));
    }
  });
  const approvals: Installed[] = [];
  const approve = Effect.gen(function* () {
    const loaded = yield* readManifest(folder);
    approvals.splice(0, approvals.length, {
      plugin: loaded.manifest.id,
      folder: loaded.folder,
      digest: loaded.digest,
    });
  });
  const handle = yield* devControl({
    folder,
    approvals: () => approvals,
  });
  const reload = (path: string) =>
    handle(JSON.stringify({ type: "reload", folder: path })).pipe(
      Effect.map((result) => result.reply),
    );
  return { root, folder, other, approvals, approve, handle, reload };
});

const withHost = <A, E>(
  test: (
    starts: number[],
    exit: (plugin: string, run: number) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, PluginHost>,
  options?: {
    readonly exitAfterReady?: boolean;
    readonly policy?: RestartPolicy;
  },
) => {
  const runner = fakeRunner(options?.exitAfterReady ?? false);
  const hostLayer = options?.policy
    ? pluginHostLayer({ logger, policy: options.policy })
    : pluginHostLayer({ logger });
  return test(runner.starts, runner.exit).pipe(
    Effect.provide(
      hostLayer.pipe(
        Layer.provide(runner.layer),
        Layer.provide(PluginGrants.refuseAll),
      ),
    ),
  );
};

describe("plugin dev control", () => {
  it.live(
    "runs the plugin whose id the manifest names when the folder has two approvals",
    () =>
      withHost(() =>
        Effect.gen(function* () {
          const host = yield* PluginHost;
          const { folder, approvals, approve, reload } = yield* setup;
          yield* approve;
          expect(yield* reload(folder)).toMatchObject({ plugin: "weather" });
          yield* Effect.promise(() =>
            writeFile(
              join(folder, "aphelion-plugin.json"),
              manifest("1.0.0").replace('"weather"', '"weather-v2"'),
            ),
          );
          const renamed = yield* readManifest(folder);
          approvals.push({
            plugin: renamed.manifest.id,
            folder: renamed.folder,
            digest: renamed.digest,
          });
          expect(yield* reload(folder)).toEqual({
            type: "reloaded",
            plugin: "weather-v2",
            state: "running",
          });
          expect(yield* host.status("weather")).toMatchObject({
            state: "stopped",
          });
        }),
      ),
  );

  it.live(
    "starts the approved dev plugin and gives each reload a fresh run",
    () =>
      withHost((starts) =>
        Effect.gen(function* () {
          const { folder, approve, reload } = yield* setup;
          yield* approve;
          expect(yield* reload(folder)).toEqual({
            type: "reloaded",
            plugin: "weather",
            state: "running",
          });
          expect(yield* reload(`${folder}/`)).toEqual({
            type: "reloaded",
            plugin: "weather",
            state: "running",
          });
          expect(starts).toEqual([1, 2]);
          const host = yield* PluginHost;
          expect(yield* host.status("weather")).toMatchObject({
            state: "running",
            run: 2,
          });
        }),
      ),
  );

  it.live("serializes back-to-back reloads so none loses its restart", () =>
    withHost((starts) =>
      Effect.gen(function* () {
        const { folder, approve, reload } = yield* setup;
        yield* approve;
        yield* reload(folder);
        const replies = yield* Effect.all(
          [reload(folder), reload(folder), reload(folder)],
          { concurrency: "unbounded" },
        );
        expect(replies).toEqual(
          Array.from({ length: 3 }, () => ({
            type: "reloaded",
            plugin: "weather",
            state: "running",
          })),
        );
        expect(starts).toEqual([1, 2, 3, 4]);
      }),
    ),
  );

  it.live(
    "refuses any folder but the dev folder and leaves the plugin running",
    () =>
      withHost((starts) =>
        Effect.gen(function* () {
          const { root, folder, other, approve, reload } = yield* setup;
          yield* approve;
          yield* reload(folder);
          const link = join(root, "link");
          yield* Effect.promise(() => symlink(folder, link));
          expect(yield* reload(link)).toMatchObject({ type: "reloaded" });
          for (const path of [other, "dev-plugin", join(root, "missing")]) {
            expect(yield* reload(path)).toEqual({
              type: "refused",
              reason: `dev mode reloads only ${folder}, not ${JSON.stringify(path)}`,
            });
          }
          expect(starts).toEqual([1, 2]);
          const host = yield* PluginHost;
          expect(yield* host.status("weather")).toMatchObject({
            state: "running",
            run: 2,
          });
        }),
      ),
  );

  it.live("refuses the dev folder until it is approved", () =>
    withHost((starts) =>
      Effect.gen(function* () {
        const { folder, reload } = yield* setup;
        expect(yield* reload(folder)).toEqual({
          type: "refused",
          reason: `${folder} isn't approved. Run aphelion plugin install ${folder} and approve it.`,
        });
        expect(starts).toEqual([]);
      }),
    ),
  );

  it.live(
    "leaves a plugin with a changed manifest stopped until it is approved again",
    () =>
      withHost((starts) =>
        Effect.gen(function* () {
          const { folder, approve, reload } = yield* setup;
          const host = yield* PluginHost;
          yield* approve;
          yield* reload(folder);
          yield* Effect.promise(() =>
            writeFile(join(folder, "aphelion-plugin.json"), manifest("1.0.1")),
          );
          const approved = yield* readManifest(folder);
          expect(yield* reload(folder)).toEqual({
            type: "refused",
            reason: `weather stays stopped: the manifest changed since it was approved. Run aphelion plugin install ${approved.folder} to approve it again.`,
          });
          expect(yield* host.status("weather")).toMatchObject({
            state: "stopped",
            reason: "requested",
          });
          expect(yield* reload(folder)).toMatchObject({ type: "refused" });
          expect(starts).toEqual([1]);
          yield* approve;
          expect(yield* reload(folder)).toEqual({
            type: "reloaded",
            plugin: "weather",
            state: "running",
          });
          expect(starts).toEqual([1, 2]);
        }),
      ),
  );

  it.live("refuses a line that isn't a reload request", () =>
    withHost(() =>
      Effect.gen(function* () {
        const { folder, handle } = yield* setup;
        expect(yield* handle("{")).toEqual({
          reply: {
            type: "refused",
            reason: "the request isn't JSON",
          },
        });
        expect(
          yield* handle(JSON.stringify({ type: "approve", folder })),
        ).toEqual({
          reply: {
            type: "refused",
            reason: "the request isn't a reload request",
          },
        });
      }),
    ),
  );
});

const ask = (path: string, lines: string) =>
  Effect.promise(
    () =>
      new Promise<DevReply[]>((resolve, reject) => {
        const socket = createConnection(path);
        let text = "";
        socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
        socket.on("error", reject);
        socket.on("close", () => {
          resolve(
            text
              .split("\n")
              .filter((line) => line !== "")
              .map((line) => JSON.parse(line) as DevReply),
          );
        });
        socket.write(lines, () => {
          setTimeout(() => socket.end(), 50);
        });
      }),
  );

const askLater = (path: string, late: string) =>
  Effect.promise(
    () =>
      new Promise<DevReply[]>((resolve, reject) => {
        const socket = createConnection({ path, allowHalfOpen: true });
        let text = "";
        socket.on("data", (chunk: Buffer) => (text += chunk.toString()));
        socket.on("error", reject);
        socket.on("end", () => {
          socket.write(late, () => {
            setTimeout(() => {
              socket.end();
              resolve(
                text
                  .split("\n")
                  .filter((line) => line !== "")
                  .map((line) => JSON.parse(line) as DevReply),
              );
            }, 50);
          });
        });
        socket.write("first\nsecond\n");
      }),
  );

describe("the plugin dev socket", () => {
  it.live(
    "answers one request at a time, is private to its owner and is removed on shutdown",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(base, "sock-")));
        const path = join(root, "plugin-dev.sock");
        const seen: string[] = [];
        const scope = yield* Scope.make();
        yield* serveDevSocket(
          path,
          (line) =>
            Effect.sync(() => {
              seen.push(line);
              return {
                reply: {
                  type: "reloaded",
                  plugin: "weather",
                  state: String(seen.length),
                },
              };
            }),
          logger,
        ).pipe(Scope.provide(scope));
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(
          0o600,
        );
        expect(yield* ask(path, "first\nsecond\n")).toEqual([
          {
            type: "refused",
            reason: "wait for the reply to your last request",
          },
        ]);
        expect(yield* askLater(path, "ignored\n")).toEqual([
          {
            type: "refused",
            reason: "wait for the reply to your last request",
          },
        ]);
        expect(seen).toEqual(["first", "first"]);
        expect(yield* ask(path, "second\n")).toEqual([
          { type: "reloaded", plugin: "weather", state: "3" },
        ]);
        expect(yield* ask(path, `${"x".repeat(70 * 1024)}\n`)).toEqual([
          { type: "refused", reason: "the request is too long" },
        ]);
        expect(seen).toEqual(["first", "first", "second"]);
        yield* Scope.close(scope, Exit.void);
        const gone = yield* Effect.promise(() =>
          stat(path).then(
            () => false,
            () => true,
          ),
        );
        expect(gone).toBe(true);
      }),
  );

  it.live("replaces a stale socket and refuses to replace another file", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(base, "stale-")));
      const path = join(root, "plugin-dev.sock");
      const left = spawnSync(process.execPath, [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.exit(0))`,
      ]);
      expect(left.status).toBe(0);
      expect((yield* Effect.promise(() => stat(path))).isSocket()).toBe(true);
      const answer = () =>
        Effect.succeed<DevResult>({
          reply: { type: "refused", reason: "fresh" },
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* serveDevSocket(path, answer, logger);
          expect(yield* ask(path, "hello\n")).toEqual([
            { type: "refused", reason: "fresh" },
          ]);
        }),
      );
      yield* Effect.promise(() => writeFile(path, "not a socket"));
      const refused = yield* Effect.scoped(
        serveDevSocket(path, answer, logger),
      ).pipe(Effect.flip);
      expect(String(refused)).toContain("isn't a socket");
    }),
  );
});

const runningReply = {
  type: "reloaded" as const,
  plugin: "weather",
  state: "running",
};

const connectDev = (path: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const socket = createConnection(path);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          resolve();
        });
        socket.once("error", reject);
      });
      socket.removeAllListeners("error");
      socket.on("error", () => undefined);
      let text = "";
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      const parse = (from: number) =>
        text
          .slice(from)
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as unknown);
      return {
        socket,
        send(body: string) {
          socket.write(`${body}\n`);
        },
        lines: () => parse(0),
        mark: () => text.length,
        wait(from: number) {
          return Effect.gen(function* () {
            for (
              let tries = 0;
              tries < 500 && parse(from).length === 0;
              tries++
            ) {
              yield* Effect.sleep("10 millis");
            }
            return parse(from);
          });
        },
      };
    }),
    (client) =>
      Effect.sync(() => {
        client.socket.destroy();
      }),
  );

describe("a crash after the dev handshake", () => {
  const open = (
    folder: string,
    handle: (line: string) => Effect.Effect<DevResult>,
  ) =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(base, "watch-")));
      const path = join(root, "plugin-dev.sock");
      yield* serveDevSocket(path, handle, logger);
      const io = yield* connectDev(path);
      return { io, request: JSON.stringify({ type: "reload", folder }) };
    });

  it.live(
    "sends the running reply and then one notice when that run exits",
    () =>
      withHost(
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const { folder, approve, handle } = yield* setup;
              yield* approve;
              const { io, request } = yield* open(folder, handle);
              io.send(request);
              yield* io.wait(0);
              yield* Effect.sleep("200 millis");
              expect(io.lines()).toEqual([
                runningReply,
                { type: "crashed", plugin: "weather" },
              ]);
            }),
          ),
        { exitAfterReady: true },
      ),
  );

  it.live(
    "sends the notice when the run crashes after the client has its reply",
    () =>
      withHost((_, exit) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { folder, approve, handle } = yield* setup;
            yield* approve;
            const { io, request } = yield* open(folder, handle);
            io.send(request);
            expect(yield* io.wait(0)).toEqual([runningReply]);
            yield* Effect.sleep("100 millis");
            expect(io.lines()).toEqual([runningReply]);
            const mark = io.mark();
            yield* exit("weather", 1);
            expect(yield* io.wait(mark)).toEqual([
              { type: "crashed", plugin: "weather" },
            ]);
          }),
        ),
      ),
  );

  it.live(
    "sends one notice when the run stops because it crashed too often",
    () =>
      withHost(
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              const { folder, approve, handle } = yield* setup;
              yield* approve;
              const { io, request } = yield* open(folder, handle);
              io.send(request);
              yield* io.wait(0);
              yield* Effect.sleep("200 millis");
              expect(io.lines()).toEqual([
                runningReply,
                { type: "crashed", plugin: "weather" },
              ]);
            }),
          ),
        {
          exitAfterReady: true,
          policy: { ...defaultRestartPolicy, maxCrashes: 0 },
        },
      ),
  );

  it.live("sends no notice for another reload or a requested stop", () =>
    withHost(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* PluginHost;
          const { folder, approve, handle } = yield* setup;
          yield* approve;
          const { io, request } = yield* open(folder, handle);
          io.send(request);
          yield* io.wait(0);
          yield* Effect.sleep("150 millis");
          expect(io.lines()).toEqual([runningReply]);
          const mark = io.mark();
          io.send(request);
          yield* io.wait(mark);
          yield* Effect.sleep("150 millis");
          expect(io.lines()).toEqual([runningReply, runningReply]);
          yield* host.stop("weather");
          yield* Effect.sleep("150 millis");
          expect(io.lines()).toEqual([runningReply, runningReply]);
        }),
      ),
    ),
  );
});
