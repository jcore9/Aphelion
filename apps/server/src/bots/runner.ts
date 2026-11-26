import {
  adapterApiVersion,
  adapterEnvelope,
  adapterMethods,
  failure,
  maxPluginLineBytes,
  pluginLineFits,
  request,
  rpcErrors,
  rpcMessageSchema,
  type RpcMessage,
  type TurnId,
} from "@aphelion/plugin-sdk";
import {
  Cause,
  Clock,
  Deferred,
  type Duration,
  Effect,
  Fiber,
  FiberSet,
  Queue,
  Semaphore,
  Stream,
} from "effect";
import { z } from "zod";
import type { Logger } from "../log";
import { LineSplitter, type LinePiece } from "../plugins/lines";
import type { Link } from "../plugins/link";
import type { ProcessExit } from "../plugins/processes";
import { logBudget, maxLogLinesPerMinute, utf8Bytes } from "../plugins/runner";
import { botEnvironment } from "./environment";
import { BotProcesses, type BotProcess } from "./processes";
import type {
  RunnerReply,
  RunnerRequest,
  StartRequest,
} from "./runner-protocol";
import { streamTracker, type StreamTracker } from "./stream";

export interface BotRunnerOptions {
  readonly home: string;
  readonly shutdownGrace: Duration.Input;
  readonly writeDeadline: Duration.Input;
  readonly logger: Logger;
}

export const maxQueuedOutputBytes = 4 * maxPluginLineBytes;

export const lineTooLong =
  "the adapter wrote a line longer than 1 MiB, and the runner dropped it";
export const notAMessage =
  "the adapter wrote a line that isn't a message the runner reads, and the runner dropped it";
export const stoppedReading =
  "the adapter stopped reading its input, and the runner killed it";
export const tooMuchLog = `the adapter wrote more than ${String(maxLogLinesPerMinute)} log lines in a minute, and the runner drops the rest of that minute`;

const initializeResult = z.object({ provider: z.string() });

type Pending =
  | { readonly kind: "initialize" }
  | { readonly kind: "turn"; readonly turn: TurnId }
  | { readonly kind: "other" };

interface Slot {
  readonly start: StartRequest;
  phase: "launching" | "initializing" | "live" | "lost" | "stopping";
  process: BotProcess | undefined;
  readonly inbox: Queue.Queue<string>;
  readonly stream: StreamTracker;
  readonly pending: Map<number, Pending>;
  readonly gone: Deferred.Deferred<undefined>;
  readonly budget: ReturnType<typeof logBudget>;
  readonly queued: Semaphore.Semaphore;
  nextId: number;
  stopReplies: number;
  failure: string | undefined;
  next: StartRequest | undefined;
}

interface Tag {
  readonly bot: string;
  readonly run: number;
}

type LoopEvent =
  | RunnerRequest
  | (Tag & { readonly type: "launched"; readonly process: BotProcess })
  | (Tag & { readonly type: "launch-failed"; readonly reason: string })
  | (Tag & {
      readonly type: "line";
      readonly piece: LinePiece;
      readonly handled: Effect.Effect<unknown>;
    })
  | (Tag & { readonly type: "exited"; readonly exit: ProcessExit })
  | (Tag & { readonly type: "stuck" })
  | (Tag & { readonly type: "stdout-closed" })
  | (Tag & { readonly type: "ended" });

const tagOf = (slot: Slot): Tag => ({
  bot: slot.start.bot,
  run: slot.start.run,
});

function parseLine(text: string): RpcMessage | undefined {
  try {
    const parsed = rpcMessageSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const runBotRunner = (
  link: Link<RunnerRequest, RunnerReply>,
  options: BotRunnerOptions,
) =>
  Effect.gen(function* () {
    const processes = yield* BotProcesses;
    const slots = new Map<string, Slot>();
    const events = yield* Queue.unbounded<LoopEvent, Cause.Done>();
    const work = yield* FiberSet.make();
    const launches = yield* FiberSet.make();

    const current = (tag: Tag) => {
      const slot = slots.get(tag.bot);
      return slot?.start.run === tag.run ? slot : undefined;
    };

    const stopAll = (bot: string) =>
      processes.stopAll(bot).pipe(
        Effect.flatMap(({ survivors }) =>
          Effect.sync(() => {
            if (survivors > 0) {
              options.logger.error(
                "the bot runner couldn't kill every process",
                { bot, survivors },
              );
            }
          }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Queue.end(events);
        yield* FiberSet.awaitEmpty(launches);
        yield* Effect.forEach([...slots.keys()], stopAll, {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    );

    const notice = (slot: Slot, line: string) =>
      Effect.gen(function* () {
        switch (slot.budget(yield* Clock.currentTimeMillis)) {
          case "send":
            return yield* link.send({ type: "log", ...tagOf(slot), line });
          case "notice":
            return yield* link.send({
              type: "log",
              ...tagOf(slot),
              line: tooMuchLog,
            });
          case "drop":
            return;
        }
      });

    const call = (
      slot: Slot,
      method: string,
      params: unknown,
      pending: Pending,
    ) => {
      const id = slot.nextId++;
      slot.pending.set(id, pending);
      return Queue.offer(
        slot.inbox,
        JSON.stringify(request(id, method, params)),
      );
    };

    const feed = (slot: Slot, process: BotProcess) =>
      Effect.gen(function* () {
        for (;;) {
          const line = yield* Queue.take(slot.inbox);
          yield* process
            .write(line)
            .pipe(Effect.timeout(options.writeDeadline));
        }
      }).pipe(
        Effect.catchTag("TimeoutError", () =>
          Queue.offer(events, { type: "stuck", ...tagOf(slot) }),
        ),
      );

    const lines = (bytes: Stream.Stream<Uint8Array>) => {
      const splitter = new LineSplitter(maxPluginLineBytes);
      return (each: (piece: LinePiece) => Effect.Effect<unknown>) =>
        Stream.runForEach(bytes, (chunk) =>
          Effect.forEach(splitter.push(chunk), each, { discard: true }),
        );
    };

    const watch = (slot: Slot, process: BotProcess) =>
      Effect.gen(function* () {
        const writer = yield* FiberSet.run(work, feed(slot, process));
        const output = yield* FiberSet.run(
          work,
          lines(process.stdout)((piece) => {
            const bytes = piece.kind === "line" ? utf8Bytes(piece.text) + 1 : 1;
            return slot.queued.take(bytes).pipe(
              Effect.andThen(
                Queue.offer(events, {
                  type: "line",
                  ...tagOf(slot),
                  piece,
                  handled: slot.queued.release(bytes),
                }),
              ),
            );
          }).pipe(
            Effect.andThen(
              Queue.offer(events, { type: "stdout-closed", ...tagOf(slot) }),
            ),
          ),
        );
        const errors = yield* FiberSet.run(
          work,
          lines(process.stderr)((piece) =>
            notice(slot, piece.kind === "line" ? piece.text : lineTooLong),
          ),
        );
        yield* FiberSet.run(
          work,
          Effect.gen(function* () {
            const exit = yield* process.exited;
            yield* Fiber.interrupt(writer);
            yield* Fiber.joinAll([output, errors]).pipe(
              Effect.timeout("1 second"),
              Effect.ignore,
            );
            yield* Queue.offer(events, {
              type: "exited",
              ...tagOf(slot),
              exit,
            });
            yield* Deferred.succeed(slot.gone, undefined);
          }),
        );
      });

    const finish = (slot: Slot, grace: Duration.Input) =>
      FiberSet.run(
        work,
        Effect.gen(function* () {
          yield* Deferred.await(slot.gone).pipe(
            Effect.timeout(grace),
            Effect.ignore,
          );
          yield* stopAll(slot.start.bot);
          yield* Deferred.await(slot.gone).pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore,
          );
          yield* Queue.offer(events, { type: "ended", ...tagOf(slot) });
        }),
      );

    const launch = (start: StartRequest) =>
      Effect.uninterruptible(
        processes
          .start({
            bot: start.bot,
            adapter: start.adapter,
            env: botEnvironment(start.provider, options.home),
            cwd: start.folder,
          })
          .pipe(
            Effect.matchEffect({
              onSuccess: (process) =>
                Queue.offer(events, {
                  type: "launched",
                  bot: start.bot,
                  run: start.run,
                  process,
                }).pipe(
                  Effect.flatMap((handedOver) =>
                    handedOver ? Effect.void : stopAll(start.bot),
                  ),
                ),
              onFailure: (failed) =>
                Queue.offer(events, {
                  type: "launch-failed",
                  bot: start.bot,
                  run: start.run,
                  reason: failed.reason,
                }),
            }),
            Effect.asVoid,
          ),
      );

    const begin = Effect.fnUntraced(function* (start: StartRequest) {
      const existing = slots.get(start.bot);
      if (existing?.phase === "stopping") {
        existing.next = start;
        return;
      }
      if (existing !== undefined) {
        return yield* link.send({
          type: "start-failed",
          bot: start.bot,
          run: start.run,
          stage: "spawn",
          reason: "already running",
        });
      }
      slots.set(start.bot, {
        start,
        phase: "launching",
        process: undefined,
        inbox: yield* Queue.unbounded<string>(),
        stream: streamTracker(),
        pending: new Map(),
        gone: yield* Deferred.make<undefined>(),
        budget: logBudget(),
        queued: yield* Semaphore.make(maxQueuedOutputBytes),
        nextId: 1,
        stopReplies: 0,
        failure: undefined,
        next: undefined,
      });
      yield* FiberSet.run(launches, launch(start));
    });

    const close = Effect.fnUntraced(function* (slot: Slot) {
      slots.delete(slot.start.bot);
      for (let count = 0; count < slot.stopReplies; count++) {
        yield* link.send({ type: "stopped", ...tagOf(slot) });
      }
      if (slot.next !== undefined) yield* begin(slot.next);
    });

    const answer = Effect.fnUntraced(function* (
      slot: Slot,
      message: Exclude<RpcMessage, { method: string }>,
    ) {
      const pending =
        typeof message.id === "number"
          ? slot.pending.get(message.id)
          : undefined;
      if (pending === undefined || typeof message.id !== "number") return;
      slot.pending.delete(message.id);
      const ok = "result" in message;
      switch (pending.kind) {
        case "initialize": {
          if (slot.phase !== "initializing") return;
          const provider = ok
            ? initializeResult.safeParse(message.result).data?.provider
            : undefined;
          if (provider === slot.start.provider) {
            slot.phase = "live";
            return yield* link.send({ type: "started", ...tagOf(slot) });
          }
          slot.phase = "stopping";
          slot.failure = ok
            ? "the adapter is for another provider"
            : "the adapter refused to start";
          yield* call(slot, adapterMethods.shutdown, undefined, {
            kind: "other",
          });
          yield* finish(slot, options.shutdownGrace);
          return;
        }
        case "turn":
          if (ok) {
            slot.stream.begin(pending.turn);
            return yield* link.send({
              type: "turn.accepted",
              ...tagOf(slot),
              turn: pending.turn,
            });
          }
          return yield* link.send({
            type: "turn.refused",
            ...tagOf(slot),
            turn: pending.turn,
            reason:
              "error" in message && message.error.code === rpcErrors.busy.code
                ? "busy"
                : "refused",
          });
        case "other":
          return;
      }
    });

    const onLine = Effect.fnUntraced(function* (slot: Slot, piece: LinePiece) {
      if (piece.kind === "too-long") return yield* notice(slot, lineTooLong);
      const message = parseLine(piece.text);
      if (message === undefined) return yield* notice(slot, notAMessage);
      if (!("method" in message)) return yield* answer(slot, message);
      if ("id" in message) {
        return yield* Queue.offer(
          slot.inbox,
          JSON.stringify(failure(message.id, rpcErrors.methodNotFound)),
        );
      }
      const envelope =
        message.method === adapterMethods.event
          ? adapterEnvelope.safeParse(message.params)
          : undefined;
      if (!envelope?.success) return yield* notice(slot, notAMessage);
      slot.stream.observe(envelope.data);
      yield* link.send({
        type: "event",
        ...tagOf(slot),
        envelope: envelope.data,
      });
    });

    const abandon = Effect.fnUntraced(function* (slot: Slot) {
      for (const envelope of slot.stream.repair()) {
        yield* link.send({ type: "event", ...tagOf(slot), envelope });
      }
      for (const pending of slot.pending.values()) {
        if (pending.kind !== "turn") continue;
        yield* link.send({
          type: "turn.refused",
          ...tagOf(slot),
          turn: pending.turn,
          reason: "not-running",
        });
      }
      slot.pending.clear();
    });

    const handle = Effect.fnUntraced(function* (event: LoopEvent) {
      switch (event.type) {
        case "start":
          return yield* begin(event);
        case "launched": {
          const slot = current(event);
          if (slot === undefined) {
            yield* FiberSet.run(work, stopAll(event.bot));
            return;
          }
          slot.process = event.process;
          yield* watch(slot, event.process);
          if (slot.phase === "stopping") {
            yield* finish(slot, 0);
            return;
          }
          slot.phase = "initializing";
          yield* link.send({ type: "spawned", ...tagOf(slot) });
          return yield* call(
            slot,
            adapterMethods.initialize,
            {
              api: adapterApiVersion,
              bot: { id: slot.start.bot },
              folder: slot.start.folder,
              resume: slot.start.resume,
            },
            { kind: "initialize" },
          );
        }
        case "launch-failed": {
          const slot = current(event);
          if (slot === undefined) return;
          if (slot.phase === "stopping") return yield* close(slot);
          slots.delete(event.bot);
          return yield* link.send({
            type: "start-failed",
            ...tagOf(slot),
            stage: "spawn",
            reason: event.reason,
          });
        }
        case "line": {
          yield* event.handled;
          const slot = current(event);
          if (slot?.process === undefined) return;
          return yield* onLine(slot, event.piece);
        }
        case "stdout-closed": {
          const slot = current(event);
          if (slot === undefined) return;
          yield* abandon(slot);
          if (slot.phase === "stopping" || slot.phase === "lost") return;
          slot.phase = "lost";
          yield* FiberSet.run(work, stopAll(event.bot));
          return;
        }
        case "exited": {
          const slot = current(event);
          if (slot === undefined) return;
          yield* abandon(slot);
          yield* Queue.shutdown(slot.inbox);
          if (slot.phase === "stopping") return;
          slots.delete(event.bot);
          return yield* link.send({
            type: "exited",
            ...tagOf(slot),
            ...event.exit,
          });
        }
        case "stuck": {
          const slot = current(event);
          if (slot === undefined) return;
          if (slot.phase === "stopping" || slot.phase === "lost") return;
          slot.phase = "lost";
          yield* notice(slot, stoppedReading);
          yield* FiberSet.run(work, stopAll(event.bot));
          return;
        }
        case "ended": {
          const slot = current(event);
          if (slot?.phase !== "stopping") return;
          if (slot.failure !== undefined) {
            yield* link.send({
              type: "start-failed",
              ...tagOf(slot),
              stage: "initialize",
              reason: slot.failure,
            });
          }
          return yield* close(slot);
        }
        case "turn.start": {
          const slot = current(event);
          const refuse = (reason: "not-running" | "too-long") =>
            link.send({
              type: "turn.refused",
              bot: event.bot,
              run: event.run,
              turn: event.turn,
              reason,
            });
          if (slot?.phase !== "live") return yield* refuse("not-running");
          const params = { turn: event.turn, text: event.text };
          const line = JSON.stringify(
            request(slot.nextId, adapterMethods.turnStart, params),
          );
          if (!pluginLineFits(line)) return yield* refuse("too-long");
          return yield* call(slot, adapterMethods.turnStart, params, {
            kind: "turn",
            turn: event.turn,
          });
        }
        case "turn.cancel": {
          const slot = current(event);
          if (slot?.phase !== "live") return;
          return yield* call(
            slot,
            adapterMethods.turnCancel,
            { turn: event.turn },
            { kind: "other" },
          );
        }
        case "stop": {
          const stopped = link.send({
            type: "stopped",
            bot: event.bot,
            run: event.run,
          });
          const slot = slots.get(event.bot);
          if (slot === undefined) return yield* stopped;
          if (slot.start.run !== event.run) {
            if (slot.next?.run === event.run) slot.next = undefined;
            return yield* stopped;
          }
          slot.stopReplies++;
          if (slot.phase === "stopping") return;
          const launched = slot.phase !== "launching";
          slot.phase = "stopping";
          if (!launched) return;
          yield* call(slot, adapterMethods.shutdown, undefined, {
            kind: "other",
          });
          yield* finish(slot, options.shutdownGrace);
          return;
        }
      }
    });

    yield* Queue.take(link.incoming).pipe(
      Effect.flatMap((frame) => Queue.offer(events, frame)),
      Effect.forever,
      Effect.catchIf(Cause.isDone, () => Queue.end(events)),
      Effect.forkScoped,
    );

    yield* Queue.take(events).pipe(Effect.flatMap(handle), Effect.forever);
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
