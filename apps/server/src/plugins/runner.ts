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

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

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

interface Inbox {
  readonly run: number;
  readonly inbox: Queue.Queue<string>;
  pendingBytes: number;
}

type Slot =
  | (Inbox & { readonly phase: "launching" })
  | (Inbox & { readonly phase: "live"; readonly process: PluginProcess });

type LiveSlot = Extract<Slot, { phase: "live" }>;

type LoopEvent =
  | RunnerRequest
  | {
      readonly type: "launched";
      readonly plugin: string;
      readonly run: number;
      readonly process: PluginProcess;
    }
  | {
      readonly type: "launch-failed";
      readonly plugin: string;
      readonly run: number;
      readonly reason: string;
    };

export const runRunner = (
  link: Link<RunnerRequest, RunnerReply>,
  options: RunnerOptions,
) =>
  Effect.gen(function* () {
    const processes = yield* PluginProcesses;
    const slots = new Map<string, Slot>();
    const events = yield* Queue.unbounded<LoopEvent, Cause.Done>();

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
      Effect.forEach(
        [...slots.values()],
        (slot) => (slot.phase === "live" ? slot.process.kill : Effect.void),
        { discard: true },
      ),
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

    const fault = (plugin: string, entry: LiveSlot) =>
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

    const feed = (plugin: string, entry: LiveSlot) =>
      Effect.gen(function* () {
        for (;;) {
          const line = yield* Queue.take(entry.inbox);
          yield* entry.process
            .write(line)
            .pipe(Effect.timeout(options.inputDeadline));
          entry.pendingBytes -= utf8Bytes(line);
        }
      }).pipe(Effect.catchTag("TimeoutError", () => fault(plugin, entry)));

    const killAndReap = (plugin: string, process: PluginProcess) =>
      process.kill.pipe(Effect.flatMap(report(plugin)), Effect.forkScoped);

    const start = Effect.fnUntraced(function* (request: StartRequest) {
      const { plugin, run } = request;
      if (slots.has(plugin)) {
        return yield* link.send({
          type: "start-failed",
          plugin,
          run,
          reason: "already running",
        });
      }
      slots.set(plugin, {
        phase: "launching",
        run,
        inbox: yield* Queue.unbounded<string>(),
        pendingBytes: 0,
      });
      const dataFolder = join(options.dataRoot, plugin);
      yield* processes
        .spawn({
          plugin,
          folder: request.folder,
          entry: request.entry,
          dataFolder,
          env: pluginEnvironment(plugin, dataFolder),
        })
        .pipe(
          Effect.matchEffect({
            onSuccess: (process) =>
              Queue.offer(events, { type: "launched", plugin, run, process }),
            onFailure: (failure) =>
              Queue.offer(events, {
                type: "launch-failed",
                plugin,
                run,
                reason: failure.reason,
              }),
          }),
          Effect.forkScoped({ startImmediately: true }),
        );
    });

    const launched = Effect.fnUntraced(function* (
      plugin: string,
      run: number,
      process: PluginProcess,
    ) {
      const slot = slots.get(plugin);
      if (slot?.phase !== "launching" || slot.run !== run) {
        yield* killAndReap(plugin, process);
        return;
      }
      const entry: LiveSlot = { ...slot, phase: "live", process };
      slots.set(plugin, entry);
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
          if (slots.get(plugin) !== entry) return;
          slots.delete(plugin);
          yield* link.send({ type: "exited", plugin, run, ...exit });
        }),
      );
    });

    const handle = (event: LoopEvent) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "start":
            return yield* start(event);
          case "launched":
            return yield* launched(event.plugin, event.run, event.process);
          case "launch-failed": {
            const slot = slots.get(event.plugin);
            if (slot?.phase !== "launching" || slot.run !== event.run) return;
            slots.delete(event.plugin);
            return yield* link.send({
              type: "start-failed",
              plugin: event.plugin,
              run: event.run,
              reason: event.reason,
            });
          }
          case "stop": {
            const { plugin, run } = event;
            const stopped = link.send({ type: "stopped", plugin, run });
            const slot = slots.get(plugin);
            if (slot?.run !== run) return yield* stopped;
            slots.delete(plugin);
            yield* Queue.shutdown(slot.inbox);
            if (slot.phase === "launching") return yield* stopped;
            return yield* slot.process.kill.pipe(
              Effect.flatMap(report(plugin)),
              Effect.andThen(stopped),
              Effect.forkScoped,
            );
          }
          case "input": {
            const slot = slots.get(event.plugin);
            if (slot?.run !== event.run) return;
            if (!(yield* Queue.offer(slot.inbox, event.line))) return;
            slot.pendingBytes += utf8Bytes(event.line);
            if (slot.pendingBytes <= maxPendingInputBytes) return;
            if (slot.phase === "live") return yield* fault(event.plugin, slot);
            slots.delete(event.plugin);
            yield* Queue.shutdown(slot.inbox);
            yield* link.send({
              type: "log",
              plugin: event.plugin,
              run: event.run,
              line: stoppedReading,
            });
            return yield* link.send({
              type: "start-failed",
              plugin: event.plugin,
              run: event.run,
              reason: stoppedReading,
            });
          }
        }
      });

    yield* Queue.take(link.incoming).pipe(
      Effect.flatMap((request) => Queue.offer(events, request)),
      Effect.forever,
      Effect.catchIf(Cause.isDone, () => Queue.end(events)),
      Effect.forkScoped,
    );

    yield* Effect.forever(Queue.take(events).pipe(Effect.flatMap(handle)));
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
