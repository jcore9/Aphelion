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
  type SessionRef,
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
import { logBudget, utf8Bytes } from "../plugins/runner";
import { BotProcesses, type BotProcess } from "./processes";
import type {
  RunnerNotice,
  RunnerReply,
  RunnerRequest,
  StartRequest,
  TurnRefusal,
} from "./runner-protocol";
import { streamTracker, type StreamTracker } from "./stream";

export interface BotRunnerOptions {
  readonly shutdownGrace: Duration.Input;
  readonly writeDeadline: Duration.Input;
  readonly logger: Logger;
}

export const maxQueuedOutputBytes = 4 * maxPluginLineBytes;

export const cancelGrace = "6 seconds";

export const killFailed =
  "the cgroup supervisor couldn't remove the bot's processes, so the bot stays stopped";

export const wedgedReason = "the bot's last processes couldn't be removed";

const initializeResult = z.object({ provider: z.string() });

type Pending =
  | { readonly kind: "initialize" }
  | { readonly kind: "turn"; readonly turn: TurnId }
  | { readonly kind: "other" };

type Phase =
  | "launching"
  | "initializing"
  | "live"
  | "cancelling"
  | "killing"
  | "lost"
  | "stopping";

interface Slot {
  readonly start: StartRequest;
  phase: Phase;
  gen: number;
  process: BotProcess | undefined;
  inbox: Queue.Queue<string>;
  pending: Map<number, Pending>;
  gone: Deferred.Deferred<undefined>;
  queued: Semaphore.Semaphore;
  nextId: number;
  seqBase: number;
  readonly stream: StreamTracker;
  readonly budget: ReturnType<typeof logBudget>;
  resume: SessionRef | null;
  restarting: boolean;
  cancel:
    | { readonly turn: TurnId; readonly done: Deferred.Deferred<undefined> }
    | undefined;
  exit: ProcessExit | undefined;
  stopReplies: number;
  failure: string | undefined;
  next: StartRequest | undefined;
}

interface Tag {
  readonly bot: string;
  readonly run: number;
  readonly gen: number;
}

type LoopEvent =
  | RunnerRequest
  | (Tag & { readonly type: "launched"; readonly process: BotProcess })
  | (Tag & {
      readonly type: "launch-failed";
      readonly stage: "spawn" | "cgroups";
      readonly reason: string;
    })
  | (Tag & {
      readonly type: "line";
      readonly piece: LinePiece;
      readonly handled: Effect.Effect<unknown>;
    })
  | (Tag & { readonly type: "exited"; readonly exit: ProcessExit })
  | (Tag & { readonly type: "stuck" })
  | (Tag & { readonly type: "stdout-closed" })
  | (Tag & { readonly type: "cancel-done" })
  | (Tag & { readonly type: "killed"; readonly ok: boolean })
  | (Tag & { readonly type: "ended" });

const tagOf = (slot: Slot): Tag => ({
  bot: slot.start.bot,
  run: slot.start.run,
  gen: slot.gen,
});

const frameOf = (slot: Slot) => ({
  bot: slot.start.bot,
  run: slot.start.run,
});

function refusalOf(code: number | null): TurnRefusal {
  if (code === rpcErrors.busy.code) return "busy";
  if (code === rpcErrors.turnEnded.code) return "ended";
  return "refused";
}

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
    const wedged = new Set<string>();
    const events = yield* Queue.unbounded<LoopEvent, Cause.Done>();
    const work = yield* FiberSet.make();
    const launches = yield* FiberSet.make();

    const current = (tag: Tag) => {
      const slot = slots.get(tag.bot);
      return slot?.start.run === tag.run && slot.gen === tag.gen
        ? slot
        : undefined;
    };

    const named = (bot: string, run: number) => {
      const slot = slots.get(bot);
      return slot?.start.run === run ? slot : undefined;
    };

    const kill = (bot: string, process: BotProcess) =>
      process.kill.pipe(
        Effect.as(true),
        Effect.catchTag("KillFailed", ({ reason }) =>
          Effect.sync(() => {
            options.logger.error(killFailed, { bot, reason });
            wedged.add(bot);
            return false;
          }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Queue.end(events);
        yield* FiberSet.awaitEmpty(launches);
        yield* Effect.forEach(
          [...slots.values()],
          (slot) =>
            slot.process ? kill(slot.start.bot, slot.process) : Effect.void,
          { concurrency: "unbounded", discard: true },
        );
      }),
    );

    const freshProcess = (slot: Slot) =>
      Effect.gen(function* () {
        slot.process = undefined;
        slot.inbox = yield* Queue.unbounded<string>();
        slot.pending = new Map();
        slot.gone = yield* Deferred.make<undefined>();
        slot.queued = yield* Semaphore.make(maxQueuedOutputBytes);
        slot.nextId = 1;
      });

    const report = (
      slot: Slot,
      reply: (
        frame: ReturnType<typeof frameOf>,
      ) => Extract<RunnerReply, { type: "log" | "notice" }>,
    ) =>
      Effect.gen(function* () {
        switch (slot.budget(yield* Clock.currentTimeMillis)) {
          case "send":
            return yield* link.send(reply(frameOf(slot)));
          case "notice":
            return yield* link.send({
              type: "notice",
              ...frameOf(slot),
              code: "too-much-log",
            });
          case "drop":
            return;
        }
      });

    const notice = (slot: Slot, code: Exclude<RunnerNotice, "too-much-log">) =>
      report(slot, (frame) => ({ type: "notice", ...frame, code }));

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

    const feed = (tag: Tag, inbox: Queue.Queue<string>, process: BotProcess) =>
      Effect.gen(function* () {
        for (;;) {
          const line = yield* Queue.take(inbox);
          yield* process
            .write(line)
            .pipe(Effect.timeout(options.writeDeadline));
        }
      }).pipe(
        Effect.catchTag("TimeoutError", () =>
          Queue.offer(events, { type: "stuck", ...tag }),
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
        const tag = tagOf(slot);
        const { queued, gone } = slot;
        const writer = yield* FiberSet.run(
          work,
          feed(tag, slot.inbox, process),
        );
        const output = yield* FiberSet.run(
          work,
          lines(process.stdout)((piece) => {
            const bytes = piece.kind === "line" ? utf8Bytes(piece.text) + 1 : 1;
            return queued.take(bytes).pipe(
              Effect.andThen(
                Queue.offer(events, {
                  type: "line",
                  ...tag,
                  piece,
                  handled: queued.release(bytes),
                }),
              ),
            );
          }).pipe(
            Effect.andThen(
              Queue.offer(events, { type: "stdout-closed", ...tag }),
            ),
          ),
        );
        const errors = yield* FiberSet.run(
          work,
          lines(process.stderr)((piece) =>
            piece.kind === "line"
              ? report(slot, (frame) => ({
                  type: "log",
                  ...frame,
                  line: piece.text,
                }))
              : notice(slot, "line-too-long"),
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
            yield* Queue.offer(events, { type: "exited", ...tag, exit });
            yield* Deferred.succeed(gone, undefined);
          }),
        );
      });

    const finish = (slot: Slot, grace: Duration.Input) =>
      FiberSet.run(
        work,
        Effect.gen(function* () {
          const tag = tagOf(slot);
          const { gone, process } = slot;
          yield* Deferred.await(gone).pipe(
            Effect.timeout(grace),
            Effect.ignore,
          );
          if (process) yield* kill(tag.bot, process);
          yield* Deferred.await(gone).pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore,
          );
          yield* Queue.offer(events, { type: "ended", ...tag });
        }),
      );

    const launch = (slot: Slot) => {
      const tag = tagOf(slot);
      return Effect.uninterruptible(
        processes
          .start({ bot: slot.start.bot, adapter: slot.start.adapter })
          .pipe(
            Effect.matchEffect({
              onSuccess: (process) =>
                Queue.offer(events, { type: "launched", ...tag, process }).pipe(
                  Effect.flatMap((handedOver) =>
                    handedOver ? Effect.void : kill(tag.bot, process),
                  ),
                ),
              onFailure: (failed) =>
                Queue.offer(events, {
                  type: "launch-failed",
                  ...tag,
                  ...(failed._tag === "CgroupsUnsafe"
                    ? {
                        stage: "cgroups" as const,
                        reason: `${failed.step}: ${failed.errno}`,
                      }
                    : { stage: "spawn" as const, reason: failed.reason }),
                }),
            }),
            Effect.asVoid,
          ),
      );
    };

    const begin = Effect.fnUntraced(function* (start: StartRequest) {
      const existing = slots.get(start.bot);
      if (existing?.phase === "stopping") {
        existing.next = start;
        return;
      }
      const refuse = (reason: string) =>
        link.send({
          type: "start-failed",
          bot: start.bot,
          run: start.run,
          stage: "spawn",
          reason,
        });
      if (existing !== undefined) return yield* refuse("already running");
      if (wedged.has(start.bot)) return yield* refuse(wedgedReason);
      const slot: Slot = {
        start,
        phase: "launching",
        gen: 1,
        process: undefined,
        inbox: yield* Queue.unbounded<string>(),
        pending: new Map(),
        gone: yield* Deferred.make<undefined>(),
        queued: yield* Semaphore.make(maxQueuedOutputBytes),
        nextId: 1,
        seqBase: 0,
        stream: streamTracker(),
        budget: logBudget(),
        resume: start.resume,
        restarting: false,
        cancel: undefined,
        exit: undefined,
        stopReplies: 0,
        failure: undefined,
        next: undefined,
      };
      slots.set(start.bot, slot);
      yield* FiberSet.run(launches, launch(slot));
    });

    const close = Effect.fnUntraced(function* (slot: Slot) {
      slots.delete(slot.start.bot);
      if (slot.failure !== undefined) {
        yield* link.send({
          type: "start-failed",
          ...frameOf(slot),
          stage: "initialize",
          reason: slot.failure,
        });
      }
      if (slot.exit !== undefined) {
        yield* link.send({ type: "exited", ...frameOf(slot), ...slot.exit });
      }
      for (let count = 0; count < slot.stopReplies; count++) {
        yield* link.send({ type: "stopped", ...frameOf(slot) });
      }
      if (slot.next !== undefined) yield* begin(slot.next);
    });

    const reap = Effect.fnUntraced(function* (slot: Slot, exit: ProcessExit) {
      slot.phase = "stopping";
      slot.restarting = false;
      slot.exit = exit;
      yield* finish(slot, 0);
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
            if (slot.restarting) {
              slot.restarting = false;
              return;
            }
            return yield* link.send({ type: "started", ...frameOf(slot) });
          }
          yield* call(slot, adapterMethods.shutdown, undefined, {
            kind: "other",
          });
          if (slot.restarting) {
            slot.restarting = false;
            slot.phase = "stopping";
            slot.exit = { code: null, signal: null };
            yield* finish(slot, options.shutdownGrace);
            return;
          }
          slot.phase = "stopping";
          slot.failure = ok
            ? "the adapter is for another provider"
            : "the adapter refused to start";
          yield* finish(slot, options.shutdownGrace);
          return;
        }
        case "turn":
          if (ok) {
            slot.stream.begin(pending.turn);
            return yield* link.send({
              type: "turn.accepted",
              ...frameOf(slot),
              turn: pending.turn,
            });
          }
          return yield* link.send({
            type: "turn.refused",
            ...frameOf(slot),
            turn: pending.turn,
            reason: refusalOf("error" in message ? message.error.code : null),
          });
        case "other":
          return;
      }
    });

    const onLine = Effect.fnUntraced(function* (slot: Slot, piece: LinePiece) {
      if (piece.kind === "too-long")
        return yield* notice(slot, "line-too-long");
      const message = parseLine(piece.text);
      if (message === undefined) return yield* notice(slot, "not-a-message");
      if (!("method" in message)) return yield* answer(slot, message);
      if ("id" in message) {
        return yield* Queue.offer(
          slot.inbox,
          JSON.stringify(failure(message.id, rpcErrors.methodNotFound)),
        );
      }
      const parsed =
        message.method === adapterMethods.event
          ? adapterEnvelope.safeParse(message.params)
          : undefined;
      if (!parsed?.success) return yield* notice(slot, "not-a-message");
      const envelope = { ...parsed.data, seq: parsed.data.seq + slot.seqBase };
      slot.stream.observe(envelope);
      const { event } = envelope;
      if (event.type === "session") slot.resume = event.ref;
      if (
        event.type === "turn.end" &&
        slot.cancel !== undefined &&
        envelope.turn === slot.cancel.turn
      ) {
        yield* Deferred.succeed(slot.cancel.done, undefined);
      }
      yield* link.send({ type: "event", ...frameOf(slot), envelope });
    });

    const abandon = Effect.fnUntraced(function* (slot: Slot) {
      for (const envelope of slot.stream.repair()) {
        yield* link.send({ type: "event", ...frameOf(slot), envelope });
      }
      for (const pending of slot.pending.values()) {
        if (pending.kind !== "turn") continue;
        yield* link.send({
          type: "turn.refused",
          ...frameOf(slot),
          turn: pending.turn,
          reason: "not-running",
        });
      }
      slot.pending.clear();
      if (slot.cancel !== undefined) {
        yield* Deferred.succeed(slot.cancel.done, undefined);
      }
    });

    const loseProcess = Effect.fnUntraced(function* (slot: Slot) {
      slot.phase = "lost";
      const { process } = slot;
      if (process) yield* FiberSet.run(work, kill(slot.start.bot, process));
    });

    const turnOpen = (slot: Slot, turn: TurnId) =>
      slot.stream.open() === turn ||
      [...slot.pending.values()].some(
        (pending) => pending.kind === "turn" && pending.turn === turn,
      );

    const handle = Effect.fnUntraced(function* (event: LoopEvent) {
      switch (event.type) {
        case "start":
          return yield* begin(event);
        case "launched": {
          const slot = current(event);
          if (slot === undefined) {
            yield* FiberSet.run(work, kill(event.bot, event.process));
            return;
          }
          slot.process = event.process;
          yield* watch(slot, event.process);
          if (slot.phase === "stopping") {
            yield* finish(slot, 0);
            return;
          }
          slot.phase = "initializing";
          if (!slot.restarting) {
            yield* link.send({ type: "spawned", ...frameOf(slot) });
          }
          return yield* call(
            slot,
            adapterMethods.initialize,
            {
              api: adapterApiVersion,
              bot: { id: slot.start.bot },
              folder: slot.start.folder,
              resume: slot.resume,
            },
            { kind: "initialize" },
          );
        }
        case "launch-failed": {
          const slot = current(event);
          if (slot === undefined) return;
          if (slot.phase === "stopping") return yield* close(slot);
          slots.delete(event.bot);
          if (slot.restarting) {
            return yield* link.send({
              type: "exited",
              ...frameOf(slot),
              code: null,
              signal: null,
            });
          }
          return yield* link.send({
            type: "start-failed",
            ...frameOf(slot),
            stage: event.stage,
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
          if (["stopping", "lost", "killing"].includes(slot.phase)) return;
          return yield* loseProcess(slot);
        }
        case "exited": {
          const slot = current(event);
          if (slot === undefined) return;
          yield* abandon(slot);
          yield* Queue.shutdown(slot.inbox);
          if (slot.phase === "stopping" || slot.phase === "killing") return;
          return yield* reap(slot, event.exit);
        }
        case "stuck": {
          const slot = current(event);
          if (slot === undefined) return;
          if (["stopping", "lost", "killing"].includes(slot.phase)) return;
          yield* notice(slot, "stopped-reading");
          return yield* loseProcess(slot);
        }
        case "cancel-done": {
          const slot = current(event);
          if (slot?.phase !== "cancelling") return;
          slot.phase = "killing";
          slot.cancel = undefined;
          const tag = tagOf(slot);
          const { process } = slot;
          yield* FiberSet.run(
            work,
            (process ? kill(tag.bot, process) : Effect.succeed(true)).pipe(
              Effect.flatMap((ok) =>
                Queue.offer(events, { type: "killed", ...tag, ok }),
              ),
            ),
          );
          return;
        }
        case "killed": {
          const slot = current(event);
          if (slot === undefined) return;
          if (slot.phase === "stopping") return yield* close(slot);
          if (slot.phase !== "killing") return;
          if (!event.ok) {
            slots.delete(event.bot);
            return yield* link.send({
              type: "exited",
              ...frameOf(slot),
              code: null,
              signal: null,
            });
          }
          yield* abandon(slot);
          slot.seqBase = slot.stream.last();
          slot.gen += 1;
          yield* freshProcess(slot);
          slot.restarting = true;
          slot.phase = "launching";
          yield* FiberSet.run(launches, launch(slot));
          return;
        }
        case "ended": {
          const slot = current(event);
          if (slot?.phase !== "stopping") return;
          return yield* close(slot);
        }
        case "turn.start": {
          const slot = named(event.bot, event.run);
          const refuse = (reason: TurnRefusal) =>
            link.send({
              type: "turn.refused",
              bot: event.bot,
              run: event.run,
              turn: event.turn,
              reason,
            });
          if (
            slot !== undefined &&
            (slot.phase === "cancelling" ||
              slot.phase === "killing" ||
              (slot.restarting &&
                (slot.phase === "launching" || slot.phase === "initializing")))
          ) {
            return yield* refuse("busy");
          }
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
          const slot = named(event.bot, event.run);
          if (slot?.phase !== "live" || !turnOpen(slot, event.turn)) return;
          yield* call(
            slot,
            adapterMethods.turnCancel,
            { turn: event.turn },
            { kind: "other" },
          );
          const done = yield* Deferred.make<undefined>();
          slot.cancel = { turn: event.turn, done };
          slot.phase = "cancelling";
          const tag = tagOf(slot);
          yield* FiberSet.run(
            work,
            Deferred.await(done).pipe(
              Effect.timeout(cancelGrace),
              Effect.ignore,
              Effect.andThen(
                Queue.offer(events, { type: "cancel-done", ...tag }),
              ),
            ),
          );
          return;
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
          const before = slot.phase;
          slot.phase = "stopping";
          slot.restarting = false;
          if (before === "launching" || before === "killing") return;
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
