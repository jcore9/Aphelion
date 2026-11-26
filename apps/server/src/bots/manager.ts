import {
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

export class BotRunnerLink extends Context.Service<
  BotRunnerLink,
  Link<RunnerReply, RunnerRequest>
>()("aphelion/bots/BotRunnerLink") {}

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
export type TurnOutcome = "accepted" | TurnRefusal;

interface Waiter {
  readonly until: (state: BotState) => boolean;
  readonly done: Deferred.Deferred<BotState>;
}

type SlotInput =
  | LifecycleEvent
  | { readonly type: "reply"; readonly reply: RunnerReply }
  | {
      readonly type: "turn";
      readonly turn: TurnId;
      readonly text: string;
      readonly done: Deferred.Deferred<TurnOutcome>;
    }
  | { readonly type: "cancel"; readonly turn: TurnId }
  | ({ readonly type: "wait" } & Waiter);

interface Slot {
  readonly bot: BotDefinition;
  readonly adapter: string;
  readonly mailbox: Queue.Queue<SlotInput>;
  state: LifecycleState;
  turn: TurnId | undefined;
  resume: SessionRef | null;
  readonly turns: Map<TurnId, Deferred.Deferred<TurnOutcome>[]>;
  readonly waiters: Set<Waiter>;
}

export class BotManager extends Context.Service<
  BotManager,
  {
    readonly start: (bot: string) => Effect.Effect<StartOutcome>;
    readonly stop: (bot: string) => Effect.Effect<void>;
    readonly startTurn: (
      bot: string,
      turn: TurnId,
      text: string,
    ) => Effect.Effect<TurnOutcome>;
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

export interface BotManagerOptions {
  readonly bots: readonly BotDefinition[];
  readonly logger: Logger;
  readonly policy?: RestartPolicy;
  readonly adapters?: Readonly<Record<string, string>>;
  readonly stopDeadlineMs?: number;
}

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
      const definitions = new Map(options.bots.map((bot) => [bot.name, bot]));
      const slots = new Map<string, Slot>();

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
          const waiting = slot.turns.get(turn) ?? [];
          slot.turns.delete(turn);
          yield* Effect.forEach(
            waiting,
            (done) => Deferred.succeed(done, outcome),
            { discard: true },
          );
        });

      const sendStart = (slot: Slot, run: number) =>
        Effect.suspend(() =>
          link.send({
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
                saved?.folder === slot.bot.folder ? saved.ref : null;
              return yield* sendStart(slot, command.run);
            }
            case "initialize":
              return;
            case "shutdown":
            case "kill":
              return yield* link.send({
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

      const apply = (slot: Slot, event: LifecycleEvent) =>
        Effect.gen(function* () {
          const before = slot.state;
          const next = step(before, event, policy);
          slot.state = next.state;
          if (next.state.state !== "running") slot.turn = undefined;
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
        });

      const onReply = (slot: Slot, reply: RunnerReply) =>
        Effect.gen(function* () {
          const bot = slot.bot.name;
          switch (reply.type) {
            case "spawned":
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
              if (reply.run === slot.state.run) slot.turn = reply.turn;
              yield* settleTurn(slot, reply.turn, "accepted");
              return yield* settleWaiters(slot);
            case "turn.refused":
              return yield* settleTurn(slot, reply.turn, reply.reason);
            case "event": {
              const { envelope } = reply;
              yield* PubSub.publish(events, { bot, run: reply.run, envelope });
              if (envelope.event.type === "session") {
                yield* refs.set(bot, {
                  ref: envelope.event.ref,
                  folder: slot.bot.folder,
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
              logger.info("bot wrote to stderr", { bot, line: reply.line });
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

      const handle = (slot: Slot, input: SlotInput) =>
        Effect.gen(function* () {
          switch (input.type) {
            case "reply":
              return yield* onReply(slot, input.reply);
            case "wait":
              slot.waiters.add(input);
              return yield* settleWaiters(slot);
            case "turn": {
              if (slot.state.state !== "running") {
                return yield* Deferred.succeed(input.done, "not-running");
              }
              if (slot.turn === input.turn) {
                return yield* Deferred.succeed(input.done, "accepted");
              }
              if (slot.turn !== undefined) {
                return yield* Deferred.succeed(input.done, "busy");
              }
              const waiting = slot.turns.get(input.turn);
              if (waiting !== undefined) {
                waiting.push(input.done);
                return;
              }
              slot.turns.set(input.turn, [input.done]);
              return yield* link.send({
                type: "turn.start",
                bot: slot.bot.name,
                run: slot.state.run,
                turn: input.turn,
                text: input.text,
              });
            }
            case "cancel":
              if (slot.state.state !== "running" || slot.turn !== input.turn)
                return;
              return yield* link.send({
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
        Effect.catchIf(Cause.isDone, () =>
          Effect.gen(function* () {
            logger.error("the bot runner's pipe closed");
            for (const slot of slots.values()) {
              for (const turn of [...slot.turns.keys()]) {
                yield* settleTurn(slot, turn, "not-running");
              }
            }
          }),
        ),
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
            turns: new Map(),
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
          if (slot === undefined) return;
          yield* Queue.offer(slot.mailbox, { type: "stop" });
          yield* waitFor(name, (state) => stoppedStates.has(state.state));
        });

      const startTurn = (name: string, turn: TurnId, text: string) =>
        Effect.gen(function* () {
          const slot = slots.get(name);
          if (slot === undefined) return "not-running" as const;
          if (!turnStartParams.safeParse({ turn, text }).success) {
            return "too-long" as const;
          }
          const done = yield* Deferred.make<TurnOutcome>();
          yield* Queue.offer(slot.mailbox, { type: "turn", turn, text, done });
          return yield* Deferred.await(done);
        });

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...slots.keys()], stop, {
          concurrency: "unbounded",
          discard: true,
        }).pipe(
          Effect.timeoutOption(options.stopDeadlineMs ?? 15_000),
          Effect.asVoid,
        ),
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
