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
export type TurnOutcome = "accepted" | "no-answer" | TurnRefusal;

export interface StartedTurn {
  readonly turn: TurnId;
  readonly outcome: TurnOutcome;
}

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
  readonly turns: Map<TurnId, Deferred.Deferred<TurnOutcome>[]>;
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
}

export const turnAcceptDeadlineMs = 30_000;

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
          const waiting = slot.turns.get(turn);
          if (waiting === undefined) return;
          slot.turns.delete(turn);
          if (outcome !== "accepted" && options.turns !== undefined) {
            yield* options.turns.end(turn, "refused");
          }
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
              if (reply.run === slot.state.run) slot.turn = reply.turn;
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

      const refuse = (
        input: Extract<SlotInput, { type: "turn" }>,
        outcome: TurnRefusal,
      ) =>
        Effect.gen(function* () {
          if (options.turns !== undefined) {
            yield* options.turns.end(input.turn, "refused");
          }
          yield* Deferred.succeed(input.done, outcome);
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
              if (slot.expired.has(input.turn)) return;
              if (slot.recovering) return yield* refuse(input, "busy");
              if (slot.state.state !== "running") {
                return yield* refuse(input, "not-running");
              }
              if (slot.turn !== undefined || slot.turns.size > 0) {
                return yield* refuse(input, "busy");
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
          if (slot === undefined) return;
          yield* Queue.offer(slot.mailbox, { type: "stop" });
          yield* waitFor(name, (state) => stoppedStates.has(state.state));
        });

      const expire = (
        slot: Slot,
        turn: TurnId,
        done: Deferred.Deferred<TurnOutcome>,
      ) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const run = slot.state.run;
            const expired = yield* Effect.sync(() => {
              if (!Deferred.doneUnsafe(done, Effect.succeed("no-answer"))) {
                return false;
              }
              slot.turns.delete(turn);
              slot.expired.add(turn);
              slot.recovering = true;
              return true;
            });
            if (!expired) return yield* Deferred.await(done);
            if (options.turns !== undefined) {
              yield* options.turns.end(turn, "refused");
            }
            yield* Queue.offer(slot.mailbox, { type: "recover", run });
            return "no-answer" as const;
          }),
        );

      const startTurn = (name: string, text: string) =>
        Effect.gen(function* () {
          const turn = turnId.parse(randomUUIDv7());
          const slot = slots.get(name);
          if (slot === undefined)
            return { turn, outcome: "not-running" as const };
          if (
            !turnStartParams.safeParse({ turn, text }).success ||
            !promptFitsRunnerLine(turn, text)
          ) {
            return { turn, outcome: "too-long" as const };
          }
          if (slot.recovering) return { turn, outcome: "busy" as const };
          const done = yield* Deferred.make<TurnOutcome>();
          const dispatched = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              if (
                options.turns !== undefined &&
                !(yield* options.turns.open(name, turn))
              ) {
                return false;
              }
              yield* Queue.offer(slot.mailbox, {
                type: "turn",
                turn,
                text,
                done,
              });
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
          return { turn, outcome: yield* expire(slot, turn, done) };
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
