import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Queue, Scope } from "effect";
import { afterAll, beforeAll, describe } from "vitest";
import { createLogger } from "../log";
import { devControl, serveDevSocket, type DevReply } from "./dev-control";
import type { Installed } from "./grants";
import { PluginHost, pluginHostLayer, RunnerLink } from "./host";
import { PluginGrants } from "./grants";
import { readManifest } from "./manifest-file";
import type { RunnerReply, RunnerRequest } from "./runner-protocol";

const logger = createLogger({ level: "error", write: () => undefined });

function fakeRunner() {
  const starts: number[] = [];
  const layer = Layer.effect(
    RunnerLink,
    Effect.gen(function* () {
      const incoming = yield* Queue.unbounded<RunnerReply, Cause.Done>();
      const reply = (message: RunnerReply) =>
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
                  return yield* reply({ type: "output", plugin, run, line });
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
  return { layer, starts };
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
    handle(JSON.stringify({ type: "reload", folder: path }));
  return { root, folder, other, approvals, approve, handle, reload };
});

const withHost = <A, E>(
  test: (starts: number[]) => Effect.Effect<A, E, PluginHost>,
) => {
  const runner = fakeRunner();
  return test(runner.starts).pipe(
    Effect.provide(
      pluginHostLayer({ logger }).pipe(
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
            ok: true,
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
            ok: true,
            plugin: "weather",
            state: "running",
          });
          expect(yield* reload(`${folder}/`)).toEqual({
            ok: true,
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
            ok: true,
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
          expect(yield* reload(link)).toMatchObject({ ok: true });
          for (const path of [other, "dev-plugin", join(root, "missing")]) {
            expect(yield* reload(path)).toEqual({
              ok: false,
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
          ok: false,
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
            ok: false,
            reason: `weather stays stopped: the manifest changed since it was approved. Run aphelion plugin install ${approved.folder} to approve it again.`,
          });
          expect(yield* host.status("weather")).toMatchObject({
            state: "stopped",
            reason: "requested",
          });
          expect(yield* reload(folder)).toMatchObject({ ok: false });
          expect(starts).toEqual([1]);
          yield* approve;
          expect(yield* reload(folder)).toEqual({
            ok: true,
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
          ok: false,
          reason: "the request isn't JSON",
        });
        expect(
          yield* handle(JSON.stringify({ type: "approve", folder })),
        ).toEqual({ ok: false, reason: "the request isn't a reload request" });
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
                ok: true,
                plugin: "weather",
                state: String(seen.length),
              };
            }),
          logger,
        ).pipe(Scope.provide(scope));
        expect((yield* Effect.promise(() => stat(path))).mode & 0o777).toBe(
          0o600,
        );
        expect(yield* ask(path, "first\nsecond\n")).toEqual([
          { ok: false, reason: "wait for the reply to your last request" },
          { ok: true, plugin: "weather", state: "1" },
        ]);
        expect(yield* ask(path, "second\n")).toEqual([
          { ok: true, plugin: "weather", state: "2" },
        ]);
        expect(yield* ask(path, `${"x".repeat(70 * 1024)}\n`)).toEqual([
          { ok: false, reason: "the request is too long" },
        ]);
        expect(seen).toEqual(["first", "second"]);
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
        Effect.succeed<DevReply>({ ok: false, reason: "fresh" });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* serveDevSocket(path, answer, logger);
          expect(yield* ask(path, "hello\n")).toEqual([
            { ok: false, reason: "fresh" },
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
