import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";
import { afterAll, beforeAll, describe } from "vitest";
import { createLogger } from "../log";
import {
  devSocketFile,
  serveDevSocket,
  type DevResult,
} from "../plugins/dev-control";
import { CliFailure } from "./failure";
import { CliIo } from "./io";
import { folderFingerprint, pluginDev, watchForChanges } from "./plugin-dev";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "aphelion-plugin-dev-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const until = (check: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400 && !check(); tries++) {
      yield* Effect.sleep("5 millis");
    }
    expect(check(), String(check)).toBe(true);
  });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const layer = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(""),
  });
  return { out, err, layer };
}

describe("watching a plugin folder", () => {
  it.live(
    "reloads at once, then once per change after the folder stops changing",
    () =>
      Effect.gen(function* () {
        const script = ["a", "a", "b", "c", "c", "c", "d", "d"];
        let polls = 0;
        const fingerprint = Effect.sync(
          () => script[Math.min(polls++, script.length - 1)] ?? "",
        );
        const reloaded: number[] = [];
        const watching = yield* watchForChanges(
          fingerprint,
          Effect.sync(() => void reloaded.push(polls)),
          "1 millis",
        ).pipe(Effect.forkChild);
        yield* until(() => polls > script.length + 2);
        yield* Fiber.interrupt(watching);
        expect(reloaded).toEqual([1, 5, 8]);
      }),
  );

  it.live("notices a changed, added or removed file", () =>
    Effect.gen(function* () {
      const folder = yield* Effect.promise(() => mkdtemp(join(base, "fp-")));
      yield* Effect.promise(() => writeFile(join(folder, "server.mjs"), "1"));
      const first = yield* folderFingerprint(folder);
      expect(yield* folderFingerprint(folder)).toBe(first);
      yield* Effect.promise(() => writeFile(join(folder, "server.mjs"), "22"));
      const changed = yield* folderFingerprint(folder);
      expect(changed).not.toBe(first);
      yield* Effect.promise(async () => {
        await mkdir(join(folder, "lib"));
        await writeFile(join(folder, "lib", "util.mjs"), "");
      });
      const added = yield* folderFingerprint(folder);
      expect(added).not.toBe(changed);
      yield* Effect.promise(() => rm(join(folder, "lib"), { recursive: true }));
      expect(yield* folderFingerprint(folder)).toBe(changed);
    }),
  );
});

describe("aphelion plugin dev", () => {
  it.live("says dev mode is off when the server has no dev socket", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.promise(() => mkdtemp(join(base, "off-")));
      const { err, layer } = capture();
      const failure = yield* pluginDev({ stateDir, folder: "/plugin" }).pipe(
        Effect.provide(layer),
        Effect.flip,
      );
      expect(failure).toBeInstanceOf(CliFailure);
      expect(err).toEqual([
        `Plugin dev mode is off: the server has no dev socket at ${join(stateDir, devSocketFile)}. Start Aphelion with deploy/compose.plugin-dev.yaml.`,
      ]);
    }),
  );

  it.live(
    "asks for a reload at start and after each change, and prints each reply",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stateDir = yield* Effect.promise(() =>
            mkdtemp(join(base, "state-")),
          );
          const folder = join(stateDir, "plugin");
          yield* Effect.promise(async () => {
            await mkdir(folder);
            await writeFile(join(folder, "server.mjs"), "one");
          });
          const requests: unknown[] = [];
          yield* serveDevSocket(
            join(stateDir, devSocketFile),
            (line) =>
              Effect.sync(() => {
                requests.push(JSON.parse(line));
                return {
                  reply:
                    requests.length === 2
                      ? {
                          type: "reply",
                          ok: false,
                          reason: "the manifest changed",
                        }
                      : {
                          type: "reply",
                          ok: true,
                          plugin: "weather",
                          state: "running",
                        },
                } satisfies DevResult;
              }),
            createLogger({ level: "error", write: () => undefined }),
          );
          const { out, err, layer } = capture();
          const watching = yield* pluginDev({
            stateDir,
            folder,
            every: "10 millis",
          }).pipe(Effect.provide(layer), Effect.forkChild);
          yield* until(() => out.length === 2);
          yield* Effect.promise(() =>
            writeFile(join(folder, "server.mjs"), "two"),
          );
          yield* until(() => err.length === 1);
          yield* Effect.promise(() =>
            writeFile(join(folder, "server.mjs"), "three"),
          );
          yield* until(() => out.length === 3);
          yield* Fiber.interrupt(watching);
          expect(requests).toEqual(
            Array.from({ length: 3 }, () => ({ type: "reload", folder })),
          );
          expect(out).toEqual([
            `Watching ${folder}. Press Ctrl-C to stop watching. The plugin keeps running.`,
            "Reloaded weather: the handshake finished.",
            "Reloaded weather: the handshake finished.",
          ]);
          expect(err).toEqual(["Refused: the manifest changed"]);
        }),
      ),
  );

  it.live(
    "prints a crash after the handshake, and a reload that is not running",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const stateDir = yield* Effect.promise(() =>
            mkdtemp(join(base, "state-")),
          );
          const folder = join(stateDir, "plugin");
          yield* Effect.promise(async () => {
            await mkdir(folder);
            await writeFile(join(folder, "server.mjs"), "one");
          });
          let calls = 0;
          yield* serveDevSocket(
            join(stateDir, devSocketFile),
            () =>
              Effect.sync(() => {
                calls++;
                return calls === 1
                  ? {
                      reply: {
                        type: "reply" as const,
                        ok: true as const,
                        plugin: "weather",
                        state: "running",
                      },
                      notice: Effect.succeed({
                        type: "crashed" as const,
                        plugin: "weather",
                      }),
                    }
                  : {
                      reply: {
                        type: "reply" as const,
                        ok: true as const,
                        plugin: "weather",
                        state: "crashed",
                      },
                    };
              }),
            createLogger({ level: "error", write: () => undefined }),
          );
          const order: string[] = [];
          const layer = Layer.succeed(CliIo, {
            out: (line) => Effect.sync(() => void order.push(`out ${line}`)),
            err: (line) => Effect.sync(() => void order.push(`err ${line}`)),
            stdin: Effect.succeed(""),
          });
          const watching = yield* pluginDev({
            stateDir,
            folder,
            every: "10 millis",
          }).pipe(Effect.provide(layer), Effect.forkChild);
          yield* until(() =>
            order.includes(
              "err weather crashed after the handshake. If its start() failed, the server log says why.",
            ),
          );
          yield* Effect.promise(() =>
            writeFile(join(folder, "server.mjs"), "two"),
          );
          yield* until(() =>
            order.includes(
              "err Reloaded weather, but it isn't running: crashed. The server log says why.",
            ),
          );
          yield* Fiber.interrupt(watching);
          expect(order).toEqual([
            `out Watching ${folder}. Press Ctrl-C to stop watching. The plugin keeps running.`,
            "out Reloaded weather: the handshake finished.",
            "err weather crashed after the handshake. If its start() failed, the server log says why.",
            "err Reloaded weather, but it isn't running: crashed. The server log says why.",
          ]);
        }),
      ),
  );
});
