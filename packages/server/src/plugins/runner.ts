import { join } from "node:path";
import {
  Cause,
  type Duration,
  Effect,
  Fiber,
  Queue,
  Schedule,
  Stream,
} from "effect";
import { LineSplitter } from "./lines";
import type { Link } from "./link";
import { PluginProcesses, type PluginProcess } from "./processes";
import {
  maxPluginLineBytes,
  type Proxy,
  type RunnerReply,
  type RunnerRequest,
  type StartRequest,
} from "./runner-protocol";

export interface RunnerOptions {
  readonly dataRoot: string;
  readonly sweepEvery: Duration.Input;
}

export const lineTooLong =
  "the plugin wrote a line longer than 1 MiB, and the runner dropped it";

export function pluginEnvironment(
  plugin: string,
  dataFolder: string,
  proxy: Proxy | undefined,
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: dataFolder,
    LANG: "C.UTF-8",
    APHELION_PLUGIN_ID: plugin,
    APHELION_PLUGIN_DATA: dataFolder,
    ...(proxy && {
      HTTPS_PROXY: proxy.httpsProxy,
      https_proxy: proxy.httpsProxy,
      NO_PROXY: proxy.noProxy,
      no_proxy: proxy.noProxy,
    }),
  };
}

interface Live {
  readonly run: number;
  readonly process: PluginProcess;
}

export const runRunner = (
  link: Link<RunnerRequest, RunnerReply>,
  options: RunnerOptions,
) =>
  Effect.gen(function* () {
    const processes = yield* PluginProcesses;
    const live = new Map<string, Live>();

    yield* Effect.addFinalizer(() =>
      Effect.forEach(live.values(), ({ process }) => process.kill, {
        discard: true,
      }),
    );
    yield* processes.sweep.pipe(
      Effect.repeat(Schedule.spaced(options.sweepEvery)),
      Effect.forkScoped,
    );

    const forward = (
      bytes: Stream.Stream<Uint8Array>,
      plugin: string,
      run: number,
      type: "output" | "log",
    ) => {
      const splitter = new LineSplitter(maxPluginLineBytes);
      return Stream.runForEach(bytes, (chunk) =>
        Effect.forEach(splitter.push(chunk), (piece) =>
          link.send(
            piece.kind === "line"
              ? { type, plugin, run, line: piece.text }
              : { type: "log", plugin, run, line: lineTooLong },
          ),
        ),
      );
    };

    const start = Effect.fnUntraced(function* (request: StartRequest) {
      const { plugin, run } = request;
      if (live.has(plugin)) {
        return yield* link.send({
          type: "start-failed",
          plugin,
          run,
          reason: "already running",
        });
      }
      const dataFolder = join(options.dataRoot, plugin);
      const spawned = yield* Effect.result(
        processes.spawn({
          plugin,
          folder: request.folder,
          entry: request.entry,
          dataFolder,
          env: pluginEnvironment(plugin, dataFolder, request.proxy),
        }),
      );
      if (spawned._tag === "Failure") {
        return yield* link.send({
          type: "start-failed",
          plugin,
          run,
          reason: spawned.failure.reason,
        });
      }
      const process = spawned.success;
      const entry: Live = { run, process };
      live.set(plugin, entry);
      yield* link.send({ type: "started", plugin, run });
      const output = yield* Effect.forkScoped(
        forward(process.stdout, plugin, run, "output"),
      );
      const errors = yield* Effect.forkScoped(
        forward(process.stderr, plugin, run, "log"),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const exit = yield* process.exited;
          yield* processes.sweep;
          yield* Fiber.joinAll([output, errors]).pipe(
            Effect.timeout("1 second"),
            Effect.ignore,
          );
          if (live.get(plugin) !== entry) return;
          live.delete(plugin);
          yield* link.send({ type: "exited", plugin, run, ...exit });
        }),
      );
    });

    const handle = (request: RunnerRequest) =>
      Effect.gen(function* () {
        switch (request.type) {
          case "start":
            return yield* start(request);
          case "stop": {
            const entry = live.get(request.plugin);
            if (entry) {
              live.delete(request.plugin);
              yield* entry.process.kill;
            }
            return yield* link.send({
              type: "stopped",
              plugin: request.plugin,
            });
          }
          case "input": {
            const entry = live.get(request.plugin);
            if (entry?.run === request.run) {
              yield* entry.process.write(request.line);
            }
          }
        }
      });

    yield* Effect.forever(
      Queue.take(link.incoming).pipe(Effect.flatMap(handle)),
    );
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
