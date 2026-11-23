import { join } from "node:path";
import { maxPluginLineBytes } from "@aphelion/plugin-sdk";
import {
  Cause,
  Clock,
  type Duration,
  Effect,
  Fiber,
  Queue,
  Schedule,
  Stream,
} from "effect";
import type { Logger } from "../log";
import { LineSplitter } from "./lines";
import type { Link } from "./link";
import { PluginProcesses, type Cleanup, type PluginProcess } from "./processes";
import {
  maxPendingInputBytes,
  type RunnerReply,
  type RunnerRequest,
  type StartRequest,
} from "./runner-protocol";

export interface RunnerOptions {
  readonly dataRoot: string;
  readonly sweepEvery: Duration.Input;
  readonly inputDeadline: Duration.Input;
  readonly logger: Logger;
}

export const maxLogLinesPerMinute = 1000;

export const lineTooLong =
  "the plugin wrote a line longer than 1 MiB, and the runner dropped it";
export const stoppedReading =
  "the plugin stopped reading its input, and the runner killed it";
export const tooMuchLog = `the plugin wrote more than ${String(maxLogLinesPerMinute)} log lines in a minute, counting stderr lines and dropped long lines, and the runner drops the rest of that minute`;

export function pluginEnvironment(
  plugin: string,
  dataFolder: string,
): Record<string, string> {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: dataFolder,
    LANG: "C.UTF-8",
    APHELION_PLUGIN_ID: plugin,
    APHELION_PLUGIN_DATA: dataFolder,
  };
}

function logBudget() {
  let windowStart = Number.NEGATIVE_INFINITY;
  let used = 0;
  return (now: number): "send" | "notice" | "drop" => {
    if (now - windowStart >= 60_000) {
      windowStart = now;
      used = 0;
    }
    used++;
    if (used <= maxLogLinesPerMinute) return "send";
    return used === maxLogLinesPerMinute + 1 ? "notice" : "drop";
  };
}

interface Live {
  readonly run: number;
  readonly process: PluginProcess;
  readonly inbox: Queue.Queue<string>;
  pendingBytes: number;
}

export const runRunner = (
  link: Link<RunnerRequest, RunnerReply>,
  options: RunnerOptions,
) =>
  Effect.gen(function* () {
    const processes = yield* PluginProcesses;
    const live = new Map<string, Live>();

    const report = (plugin: string | undefined) => (cleanup: Cleanup) =>
      Effect.sync(() => {
        if (cleanup.survivors > 0) {
          options.logger.error(
            "the plugin runner couldn't kill every process",
            {
              plugin,
              survivors: cleanup.survivors,
            },
          );
        }
      });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(live.values(), ({ process }) => process.kill, {
        discard: true,
      }),
    );
    yield* processes.sweep.pipe(
      Effect.flatMap(report(undefined)),
      Effect.repeat(Schedule.spaced(options.sweepEvery)),
      Effect.forkScoped,
    );

    const forward = (
      bytes: Stream.Stream<Uint8Array>,
      plugin: string,
      run: number,
      type: "output" | "log",
      budget: (now: number) => "send" | "notice" | "drop",
    ) => {
      const splitter = new LineSplitter(maxPluginLineBytes);
      const log = (line: string) =>
        Effect.gen(function* () {
          switch (budget(yield* Clock.currentTimeMillis)) {
            case "send":
              return yield* link.send({ type: "log", plugin, run, line });
            case "notice":
              return yield* link.send({
                type: "log",
                plugin,
                run,
                line: tooMuchLog,
              });
            case "drop":
              return;
          }
        });
      return Stream.runForEach(bytes, (chunk) =>
        Effect.forEach(splitter.push(chunk), (piece) =>
          piece.kind !== "line"
            ? log(lineTooLong)
            : type === "output"
              ? link.send({ type, plugin, run, line: piece.text })
              : log(piece.text),
        ),
      );
    };

    const fault = (plugin: string, entry: Live) =>
      Queue.shutdown(entry.inbox).pipe(
        Effect.andThen(
          link
            .send({ type: "log", plugin, run: entry.run, line: stoppedReading })
            .pipe(
              Effect.andThen(entry.process.kill),
              Effect.flatMap(report(plugin)),
              Effect.forkScoped,
            ),
        ),
      );

    const feed = (plugin: string, entry: Live) =>
      Effect.gen(function* () {
        for (;;) {
          const line = yield* Queue.take(entry.inbox);
          yield* entry.process
            .write(line)
            .pipe(Effect.timeout(options.inputDeadline));
          entry.pendingBytes -= line.length;
        }
      }).pipe(Effect.catchTag("TimeoutError", () => fault(plugin, entry)));

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
          env: pluginEnvironment(plugin, dataFolder),
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
      const entry: Live = {
        run,
        process,
        inbox: yield* Queue.unbounded<string>(),
        pendingBytes: 0,
      };
      live.set(plugin, entry);
      yield* link.send({ type: "started", plugin, run });
      const writer = yield* Effect.forkScoped(feed(plugin, entry));
      const budget = logBudget();
      const output = yield* Effect.forkScoped(
        forward(process.stdout, plugin, run, "output", budget),
      );
      const errors = yield* Effect.forkScoped(
        forward(process.stderr, plugin, run, "log", budget),
      );
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const exit = yield* process.exited;
          yield* Fiber.interrupt(writer);
          yield* processes.sweep.pipe(Effect.flatMap(report(plugin)));
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
            if (entry?.run === request.run) {
              live.delete(request.plugin);
              yield* Queue.shutdown(entry.inbox);
              yield* entry.process.kill.pipe(
                Effect.flatMap(report(request.plugin)),
              );
            }
            return yield* link.send({
              type: "stopped",
              plugin: request.plugin,
              run: request.run,
            });
          }
          case "input": {
            const entry = live.get(request.plugin);
            if (entry?.run !== request.run) return;
            if (!(yield* Queue.offer(entry.inbox, request.line))) return;
            entry.pendingBytes += request.line.length;
            if (entry.pendingBytes > maxPendingInputBytes) {
              yield* fault(request.plugin, entry);
            }
          }
        }
      });

    yield* Effect.forever(
      Queue.take(link.incoming).pipe(Effect.flatMap(handle)),
    );
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
