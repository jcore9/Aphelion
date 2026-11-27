import { randomUUIDv7 } from "node:crypto";
import {
  adapterMethods,
  pluginLineFits,
  request,
  turnId,
  turnStartParams,
  type AdapterEnvelope,
  type SessionRef,
  type TurnId,
} from "@aphelion/plugin-sdk";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Scope,
  Stream,
} from "effect";
import type { Logger } from "../log";
import {
  defaultRestartPolicy,
  installed,
  step,
  type LifecycleCommand,
  type LifecycleEvent,
  type LifecycleState,
  type RestartPolicy,
} from "../plugins/lifecycle";
import type { Link } from "../plugins/link";
import type {
  RunnerNotice,
  RunnerReply,
  RunnerRequest,
  TurnRefusal,
} from "./runner-protocol";
import { SessionRefs } from "./session-refs";

export const adapterBundles: Readonly<Record<string, string>> = {
  claude: "/usr/local/lib/aphelion/adapters/claude/adapter.js",
};

export const resumeFailed =
  "the saved session could not be resumed, so the bot started a new one";

export const runnerNotices = {
  "line-too-long":
    "the adapter wrote a line longer than 1 MiB, and the runner dropped it",
  "not-a-message":
    "the adapter wrote a line that isn't a message the runner reads, and the runner dropped it",
  "stopped-reading":
    "the adapter stopped reading its input, and the runner killed it",
  "too-much-log":
    "the adapter wrote more than 1000 log lines in a minute, and the runner drops the rest of that minute",
} as const satisfies Record<RunnerNotice, string>;

export interface BotLink extends Link<RunnerReply, RunnerRequest> {
  readonly close?: Effect.Effect<void>;
}

export class BotRunnerLink extends Context.Service<BotRunnerLink, BotLink>()(
  "aphelion/bots/BotRunnerLink",
) {}

export interface BotDefinition {
  readonly name: string;
  readonly provider: string;
  readonly folder: string;
}

export type BotState =
  | { readonly state: "stopped" }
  | { readonly state: "starting" }
  | { readonly state: "running" }
  | { readonly state: "in turn"; readonly turn: TurnId }
  | { readonly state: "stopping" }
  | { readonly state: "crashed"; readonly retryInMs: number }
  | { readonly state: "given up" };

export function botState(
  lifecycle: LifecycleState,
  turn: TurnId | undefined,
): BotState {
  switch (lifecycle.state) {
    case "installed":
      return { state: "stopped" };
    case "stopped":
      return lifecycle.reason === "crashed too often"
        ? { state: "given up" }
        : { state: "stopped" };
    case "starting":
      return { state: "starting" };
    case "running":
      return turn === undefined
        ? { state: "running" }
        : { state: "in turn", turn };
    case "stopping":
      return { state: "stopping" };
    case "crashed":
      return { state: "crashed", retryInMs: lifecycle.retryInMs };
  }
}

export interface BotEvent {
  readonly bot: string;
  readonly run: number;
  readonly envelope: AdapterEnvelope;
}

export type StartOutcome = "starting" | "unknown bot" | "unknown provider";
export type TurnOutcome = "accepted" | "no-answer" | TurnRefusal;

export interface StartedTurn {
  readonly turn: TurnId;
  readonly outcome: TurnOutcome;
}

interface Waiter {
  readonly until: (state: BotState) => boolean;
  readonly done: Deferred.Deferred<BotState>;
}

interface TurnRequest {
  readonly type: "turn";
  readonly turn: TurnId;
  readonly text: string;
  readonly done: Deferred.Deferred<TurnOutcome>;
  dispatchedRun: number | undefined;
  expired: boolean;
  settling: boolean;
}

type SlotInput =
  | LifecycleEvent
  | { readonly type: "reply"; readonly reply: RunnerReply }
  | TurnRequest
  | { readonly type: "cancel"; readonly turn: TurnId }
  | { readonly type: "recover"; readonly run: number }
  | ({ readonly type: "wait" } & Waiter);

interface Slot {
  readonly bot: BotDefinition;
  readonly adapter: string;
  readonly mailbox: Queue.Queue<SlotInput>;
  state: LifecycleState;
  turn: TurnId | undefined;
  resume: SessionRef | null;
  recovering: boolean;
  restart: boolean;
  stderrLines: number;
  readonly turns: Map<TurnId, TurnRequest>;
  readonly expired: Set<TurnId>;
  readonly waiters: Set<Waiter>;
}

export class BotManager extends Context.Service<
  BotManager,
  {
    readonly start: (bot: string) => Effect.Effect<StartOutcome>;
    readonly stop: (bot: string) => Effect.Effect<void>;
    readonly startTurn: (
      bot: string,
      text: string,
    ) => Effect.Effect<StartedTurn>;
    readonly cancelTurn: (bot: string, turn: TurnId) => Effect.Effect<void>;
    readonly status: (bot: string) => Effect.Effect<BotState | undefined>;
    readonly waitFor: (
      bot: string,
      until: (state: BotState) => boolean,
    ) => Effect.Effect<BotState | undefined>;
    readonly events: Stream.Stream<BotEvent>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<BotEvent>,
      never,
      Scope.Scope
    >;
  }
>()("aphelion/bots/BotManager") {}

export interface TurnLedger {
  readonly open: (bot: string, turn: TurnId) => Effect.Effect<boolean>;
  readonly end: (turn: TurnId, reason: "refused") => Effect.Effect<void>;
}

export interface BotManagerOptions {
  readonly bots: readonly BotDefinition[];
  readonly turns?: TurnLedger;
  readonly logger: Logger;
  readonly policy?: RestartPolicy;
  readonly adapters?: Readonly<Record<string, string>>;
  readonly stopDeadlineMs?: number;
  readonly turnAcceptDeadlineMs?: number;
  readonly writeDeadlineMs?: number;
  readonly onChannelFailed?: () => Effect.Effect<void>;
}

export const turnAcceptDeadlineMs = 30_000;
export const runnerWriteDeadlineMs = 10_000;
export const runnerChannelFailedMessage =
  "a write to the bot runner timed out, so the channel is closed";

const promptFitsRunnerLine = (turn: TurnId, text: string) =>
  pluginLineFits(
    JSON.stringify(
      request(Number.MAX_SAFE_INTEGER, adapterMethods.turnStart, {
        turn,
        text,
      }),
    ),
  );

const stoppedStates = new Set(["stopped", "given up"]);

export const botManagerLayer = (options: BotManagerOptions) =>
  Layer.effect(
    BotManager,
    Effect.gen(function* () {
      const link = yield* BotRunnerLink;
      const refs = yield* SessionRefs;
      const work = yield* Scope.fork(yield* Scope.Scope);
      const events = yield* PubSub.unbounded<BotEvent>();
      const { logger } = options;
      const policy = options.policy ?? {
        ...defaultRestartPolicy,
        graceMs: 10_000,
      };
      const adapters = options.adapters ?? adapterBundles;
      const writeDeadlineMs = options.writeDeadlineMs ?? runnerWriteDeadlineMs;
      const definitions = new Map(options.bots.map((bot) => [bot.name, bot]));
      const slots = new Map<string, Slot>();
      const channelDown = yield* Deferred.make<undefined>();
      let channelFailed = false;
      let shuttingDown = false;

      const stateOf = (slot: Slot) => botState(slot.state, slot.turn);

      const settleWaiters = (slot: Slot) =>
        Effect.forEach(
          [...slot.waiters].filter((waiter) => waiter.until(stateOf(slot))),
          (waiter) => {
            slot.waiters.delete(waiter);
            return Deferred.succeed(waiter.done, stateOf(slot));
          },
          { discard: true },
        );

      const settleTurn = (slot: Slot, turn: TurnId, outcome: TurnOutcome) =>
        Effect.gen(function* () {
          const pending = yield* Effect.sync(() => {
            const request = slot.turns.get(turn);
            if (request === undefined || request.settling) return undefined;
            slot.turns.delete(turn);
            request.settling = true;
            return request;
          });
          if (pending === undefined) return;
          if (outcome !== "accepted" && options.turns !== undefined) {
            yield* options.turns.end(turn, "refused");
          }
          yield* Deferred.succeed(pending.done, outcome);
        });

      const failChannel = (reason: "write-timeout" | "pipe-closed") =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            if (channelFailed) return;
            channelFailed = true;
            yield* Deferred.succeed(channelDown, undefined);
            if (reason === "write-timeout") {
              logger.error(runnerChannelFailedMessage, {
                deadlineMs: writeDeadlineMs,
              });
            } else {
              logger.error("the bot runner's pipe closed");
            }
            if (link.close !== undefined) {
              yield* link.close.pipe(Effect.ignore);
            }
            if (!shuttingDown && options.onChannelFailed !== undefined) {
              yield* options.onChannelFailed();
            }
            for (const slot of slots.values()) {
              slot.restart = false;
              slot.recovering = false;
              slot.turn = undefined;
              slot.state = {
                state: "stopped",
                run: slot.state.run,
                reason: "requested",
              };
              for (const turn of [...slot.turns.keys()]) {
                yield* settleTurn(slot, turn, "not-running");
              }
              yield* settleWaiters(slot);
            }
          }),
        );

      const sendToRunner = (message: RunnerRequest): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (channelFailed) return;
          const result = yield* Effect.raceFirst(
            link
              .send(message)
              .pipe(
                Effect.as("sent" as const),
                Effect.timeoutOption(writeDeadlineMs),
                Effect.map(Option.getOrElse(() => "timeout" as const)),
              ),
            Deferred.await(channelDown).pipe(Effect.as("closed" as const)),
          );
          if (result === "timeout") {
            yield* failChannel("write-timeout");
          }
        });

      const sendStart = (slot: Slot, run: number) =>
        Effect.suspend(() =>
          sendToRunner({
            type: "start",
            bot: slot.bot.name,
            run,
            provider: slot.bot.provider,
            adapter: slot.adapter,
            folder: slot.bot.folder,
            resume: slot.resume,
          }),
        );

      const run = (slot: Slot, command: LifecycleCommand) =>
        Effect.gen(function* () {
          switch (command.type) {
            case "spawn": {
              const saved = yield* refs.get(slot.bot.name);
              slot.resume =
                saved?.folder === slot.bot.folder &&
                saved.provider === slot.bot.provider
                  ? saved.ref
                  : null;
              return yield* sendStart(slot, command.run);
            }
            case "initialize":
              return;
            case "shutdown":
            case "kill":
              return yield* sendToRunner({
                type: "stop",
                bot: slot.bot.name,
                run: slot.state.run,
              });
            case "arm":
              yield* Effect.sleep(command.ms).pipe(
                Effect.andThen(
                  Queue.offer(slot.mailbox, {
                    type: "timer",
                    run: command.run,
                    deadline: command.deadline,
                  }),
                ),
                Effect.forkIn(work),
              );
          }
        });

      const apply = (slot: Slot, event: LifecycleEvent): Effect.Effect<void> =>
        Effect.gen(function* () {
          const before = slot.state;
          const next = step(before, event, policy);
          slot.state = next.state;
          const restarting =
            slot.restart &&
            next.state.state === "stopped" &&
            next.state.reason === "requested";
          if (next.state.state !== "running") {
            slot.turn = undefined;
          }
          if (next.state.run !== before.run) {
            slot.expired.clear();
          }
          if (
            next.state.state === "running"
              ? before.state !== "running"
              : next.state.state !== "starting" &&
                next.state.state !== "stopping" &&
                !restarting
          ) {
            slot.recovering = false;
          }
          if (next.state.state !== before.state) {
            logger.info("bot state changed", {
              bot: slot.bot.name,
              from: before.state,
              to: next.state.state,
              run: next.state.run,
            });
            if (
              next.state.state === "stopped" &&
              next.state.reason === "crashed too often"
            ) {
              logger.error("the bot crashed too often, so it stays stopped", {
                bot: slot.bot.name,
              });
            }
          }
          yield* Effect.forEach(
            next.commands,
            (command) => run(slot, command),
            {
              discard: true,
            },
          );
          yield* settleWaiters(slot);
          if (restarting) {
            slot.restart = false;
            yield* apply(slot, { type: "start" });
          }
        });

      const onReply = (slot: Slot, reply: RunnerReply) =>
        Effect.gen(function* () {
          const bot = slot.bot.name;
          switch (reply.type) {
            case "spawned":
              slot.stderrLines = 0;
              logger.info("the bot runner started the bot's process", {
                bot,
                run: reply.run,
              });
              return yield* apply(slot, { type: "spawned", run: reply.run });
            case "started":
              return yield* apply(slot, {
                type: "ready",
                run: reply.run,
                at: yield* Clock.currentTimeMillis,
              });
            case "start-failed":
              if (
                reply.stage === "initialize" &&
                slot.resume !== null &&
                reply.run === slot.state.run &&
                slot.state.state === "starting"
              ) {
                logger.warn(resumeFailed, { bot });
                yield* refs.clear(bot);
                slot.resume = null;
                return yield* sendStart(slot, reply.run);
              }
              logger.warn("the bot runner couldn't start the bot", {
                bot,
                adapter: slot.adapter,
                stage: reply.stage,
                reason: reply.reason,
              });
              return yield* apply(slot, {
                type: "spawn-failed",
                run: reply.run,
              });
            case "turn.accepted":
              if (slot.expired.has(reply.turn)) return;
              if (
                slot.state.state === "running" &&
                reply.run === slot.state.run
              ) {
                slot.turn = reply.turn;
              }
              yield* settleTurn(slot, reply.turn, "accepted");
              return yield* settleWaiters(slot);
            case "turn.refused":
              slot.expired.delete(reply.turn);
              return yield* settleTurn(slot, reply.turn, reply.reason);
            case "event": {
              const { envelope } = reply;
              yield* PubSub.publish(events, { bot, run: reply.run, envelope });
              if (envelope.event.type === "session") {
                yield* refs.set(bot, {
                  ref: envelope.event.ref,
                  folder: slot.bot.folder,
                  provider: slot.bot.provider,
                });
              }
              if (
                envelope.event.type !== "turn.end" ||
                envelope.turn === null ||
                reply.run !== slot.state.run
              ) {
                return;
              }
              if (envelope.turn === slot.turn) {
                slot.turn = undefined;
                yield* settleWaiters(slot);
              }
              return;
            }
            case "log":
              slot.stderrLines += 1;
              logger.info("bot wrote to stderr", {
                bot,
                lines: slot.stderrLines,
              });
              return;
            case "notice":
              logger.warn(runnerNotices[reply.code], {
                bot,
                run: reply.run,
              });
              return;
            case "exited":
              logger.warn("a bot process exited", {
                bot,
                code: reply.code,
                signal: reply.signal,
              });
              return yield* apply(slot, {
                type: "exited",
                run: reply.run,
                at: yield* Clock.currentTimeMillis,
              });
            case "stopped":
              return yield* apply(slot, { type: "killed", run: reply.run });
          }
        });

      const refuse = (input: TurnRequest, outcome: TurnRefusal) =>
        Effect.gen(function* () {
          const claimed = yield* Effect.sync(() => {
            if (input.settling || input.expired) return false;
            input.settling = true;
            return true;
          });
          if (!claimed) return;
          if (options.turns !== undefined) {
            yield* options.turns.end(input.turn, "refused");
          }
          yield* Deferred.succeed(input.done, outcome);
        });

      const handle = (slot: Slot, input: SlotInput) =>
        Effect.gen(function* () {
          if (channelFailed) {
            if (input.type === "wait") {
              slot.waiters.add(input);
              return yield* settleWaiters(slot);
            }
            if (input.type === "turn") {
              if (input.expired) return;
              return yield* refuse(input, "not-running");
            }
            return;
          }
          switch (input.type) {
            case "reply":
              return yield* onReply(slot, input.reply);
            case "wait":
              slot.waiters.add(input);
              return yield* settleWaiters(slot);
            case "turn": {
              const action = yield* Effect.sync(() => {
                if (input.expired) return "skip" as const;
                if (channelFailed) return "not-running" as const;
                if (slot.recovering) return "busy" as const;
                if (slot.state.state !== "running") {
                  return "not-running" as const;
                }
                if (slot.turn !== undefined || slot.turns.size > 0) {
                  return "busy" as const;
                }
                input.dispatchedRun = slot.state.run;
                slot.turns.set(input.turn, input);
                return "send" as const;
              });
              if (action === "skip") return;
              if (action !== "send") return yield* refuse(input, action);
              return yield* sendToRunner({
                type: "turn.start",
                bot: slot.bot.name,
                run: slot.state.run,
                turn: input.turn,
                text: input.text,
              });
            }
            case "recover":
              if (
                slot.state.state !== "running" ||
                slot.state.run !== input.run
              ) {
                return;
              }
              slot.restart = true;
              return yield* apply(slot, { type: "stop" });
            case "stop":
              slot.restart = false;
              slot.recovering = false;
              return yield* apply(slot, input);
            case "cancel":
              if (slot.state.state !== "running" || slot.turn !== input.turn)
                return;
              return yield* sendToRunner({
                type: "turn.cancel",
                bot: slot.bot.name,
                run: slot.state.run,
                turn: input.turn,
              });
            default:
              return yield* apply(slot, input);
          }
        });

      yield* Queue.take(link.incoming).pipe(
        Effect.flatMap((reply) => {
          const slot = slots.get(reply.bot);
          return slot
            ? Queue.offer(slot.mailbox, { type: "reply", reply })
            : Effect.void;
        }),
        Effect.forever,
        Effect.catchIf(Cause.isDone, () => failChannel("pipe-closed")),
        Effect.forkIn(work),
      );

      const slotFor = (definition: BotDefinition, adapter: string) =>
        Effect.gen(function* () {
          const existing = slots.get(definition.name);
          if (existing) return existing;
          const slot: Slot = {
            bot: definition,
            adapter,
            mailbox: yield* Queue.unbounded<SlotInput>(),
            state: installed,
            turn: undefined,
            resume: null,
            recovering: false,
            restart: false,
            stderrLines: 0,
            turns: new Map(),
            expired: new Set(),
            waiters: new Set(),
          };
          slots.set(definition.name, slot);
          yield* Queue.take(slot.mailbox).pipe(
            Effect.flatMap((input) => handle(slot, input)),
            Effect.forever,
            Effect.forkIn(work),
          );
          return slot;
        });

      const start = (name: string) =>
        Effect.gen(function* () {
          const definition = definitions.get(name);
          if (definition === undefined) return "unknown bot" as const;
          const adapter = adapters[definition.provider];
          if (adapter === undefined) {
            logger.error(
              "no adapter in this image runs the bot's provider, so the bot won't start",
              { bot: name, provider: definition.provider },
            );
            return "unknown provider" as const;
          }
          const slot = yield* slotFor(definition, adapter);
          yield* Queue.offer(slot.mailbox, { type: "start" });
          return "starting" as const;
        });

      const waitFor = (name: string, until: Waiter["until"]) =>
        Effect.gen(function* () {
          const slot = slots.get(name);
          if (slot === undefined) return undefined;
          const done = yield* Deferred.make<BotState>();
          yield* Queue.offer(slot.mailbox, { type: "wait", until, done });
          return yield* Deferred.await(done);
        });

      const stop = (name: string) =>
        Effect.gen(function* () {
          const slot = slots.get(name);
          if (slot === undefined || channelFailed) return;
          yield* Queue.offer(slot.mailbox, { type: "stop" });
          yield* waitFor(name, (state) => stoppedStates.has(state.state));
        });

      const expire = (slot: Slot, pending: TurnRequest) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const state = yield* Effect.sync(() => {
              if (pending.settling) return "settled" as const;
              pending.settling = true;
              pending.expired = true;
              const run = pending.dispatchedRun;
              if (run === undefined) return "not-dispatched" as const;
              slot.turns.delete(pending.turn);
              slot.expired.add(pending.turn);
              slot.recovering = true;
              return run;
            });
            if (state === "settled") return yield* Deferred.await(pending.done);
            if (options.turns !== undefined) {
              yield* options.turns.end(pending.turn, "refused");
            }
            yield* Deferred.succeed(pending.done, "no-answer");
            if (typeof state === "number") {
              yield* Queue.offer(slot.mailbox, { type: "recover", run: state });
            }
            return "no-answer" as const;
          }),
        );

      const startTurn = (name: string, text: string) =>
        Effect.gen(function* () {
          const turn = turnId.parse(randomUUIDv7());
          const slot = slots.get(name);
          if (slot === undefined || channelFailed)
            return { turn, outcome: "not-running" as const };
          if (
            !turnStartParams.safeParse({ turn, text }).success ||
            !promptFitsRunnerLine(turn, text)
          ) {
            return { turn, outcome: "too-long" as const };
          }
          if (slot.recovering) return { turn, outcome: "busy" as const };
          const done = yield* Deferred.make<TurnOutcome>();
          const turnRequest: TurnRequest = {
            type: "turn",
            turn,
            text,
            done,
            dispatchedRun: undefined,
            expired: false,
            settling: false,
          };
          const dispatched = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (
                options.turns !== undefined &&
                !(yield* options.turns.open(name, turn))
              ) {
                return false;
              }
              yield* Queue.offer(slot.mailbox, turnRequest);
              return true;
            }),
          );
          if (!dispatched) return { turn, outcome: "refused" as const };
          const answered = yield* Deferred.await(done).pipe(
            Effect.timeoutOption(
              options.turnAcceptDeadlineMs ?? turnAcceptDeadlineMs,
            ),
          );
          if (Option.isSome(answered)) return { turn, outcome: answered.value };
          return { turn, outcome: yield* expire(slot, turnRequest) };
        });

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          shuttingDown = true;
          yield* Effect.forEach([...slots.keys()], stop, {
            concurrency: "unbounded",
            discard: true,
          }).pipe(
            Effect.timeoutOption(options.stopDeadlineMs ?? 15_000),
            Effect.asVoid,
          );
        }),
      );

      return BotManager.of({
        start,
        stop,
        startTurn,
        cancelTurn: (name, turn) =>
          Effect.suspend(() => {
            const slot = slots.get(name);
            return slot
              ? Queue.offer(slot.mailbox, { type: "cancel", turn })
              : Effect.void;
          }).pipe(Effect.asVoid),
        status: (name) =>
          Effect.sync(() => {
            const slot = slots.get(name);
            return slot ? stateOf(slot) : undefined;
          }),
        waitFor,
        events: Stream.fromPubSub(events),
        subscribe: PubSub.subscribe(events),
      });
    }),
  );
