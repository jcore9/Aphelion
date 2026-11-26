import { randomUUIDv7 } from "node:crypto";
import type { StreamEvent } from "@aphelion/plugin-sdk";
import { Clock, Duration, Effect, Fiber, PubSub, Scope } from "effect";
import type { Logger } from "../log";
import { readStreamId, type Database } from "../store";
import {
  decodeEvent,
  encodePayload,
  eventFormat,
  type SavedEvent,
} from "./saved-event";

export interface NewEvent {
  readonly bot: string;
  readonly turn: string | null;
  readonly event: StreamEvent;
}

export interface EventLog {
  readonly serverId: string;
  readonly streamId: string;
  readonly head: () => number;
  readonly firstKept: () => number;
  readonly read: (after: number, limit: number) => readonly SavedEvent[];
  readonly turnEvents: (turn: string) => readonly SavedEvent[];
  readonly subscribe: Effect.Effect<
    PubSub.Subscription<SavedEvent>,
    never,
    Scope.Scope
  >;
}

export interface EventStore extends EventLog {
  readonly record: (entry: NewEvent) => Effect.Effect<void>;
  readonly appendNow: (entries: readonly NewEvent[]) => Effect.Effect<void>;
  readonly flush: Effect.Effect<void>;
}

export interface EventStoreOptions {
  readonly logger: Logger;
  readonly window?: Duration.Input;
  readonly maxBatch?: number;
  readonly retryAfter?: Duration.Input;
}

interface Pending extends NewEvent {
  readonly at: number;
}

const columns = "id, position, bot, turn, format, kind, payload, at";

export const openEventStore = (
  db: Database,
  serverId: string,
  {
    logger,
    window = Duration.millis(50),
    maxBatch = 200,
    retryAfter = Duration.seconds(1),
  }: EventStoreOptions,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const live = yield* PubSub.unbounded<SavedEvent>();
    let pending: Pending[] = [];
    let timer: Fiber.Fiber<void> | undefined;
    let retrying = false;

    const head = () => {
      const row = db.all(
        "SELECT CAST(value AS INTEGER) - 1 AS head FROM server_meta WHERE key = 'next_position'",
      )[0];
      return Number(row?.["head"] ?? 0);
    };

    const firstKept = () => {
      const row = db.all("SELECT MIN(position) AS first FROM events")[0];
      const first = row?.["first"];
      return typeof first === "number" ? first : head() + 1;
    };

    const claimTurn = (entry: Pending) => {
      if (entry.turn === null) return true;
      db.run(
        "INSERT INTO turns (id, server_id, bot, started_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
        [entry.turn, serverId, entry.bot, entry.at],
      );
      return (
        db.all("SELECT bot FROM turns WHERE id = ?", [entry.turn])[0]?.[
          "bot"
        ] === entry.bot
      );
    };

    const write = (batch: readonly Pending[]): SavedEvent[] =>
      db.transaction(() => {
        const accepted = batch.filter(claimTurn);
        if (accepted.length < batch.length) {
          logger.error("bot events for another bot's turn were not saved", {
            count: batch.length - accepted.length,
          });
        }
        if (accepted.length === 0) return [];
        const next = Number(
          db.all(
            "UPDATE server_meta SET value = CAST(value AS INTEGER) + ? WHERE key = 'next_position' RETURNING CAST(value AS INTEGER) AS next",
            [accepted.length],
          )[0]?.["next"],
        );
        const first = next - accepted.length;
        return accepted.map((entry, index) => {
          const id = randomUUIDv7();
          const position = first + index;
          db.run(
            `INSERT INTO events (id, position, bot, turn, format, kind, payload, at, server_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              position,
              entry.bot,
              entry.turn,
              eventFormat,
              entry.event.type,
              encodePayload(entry.event),
              entry.at,
              serverId,
            ],
          );
          if (entry.turn !== null && entry.event.type === "turn.end") {
            db.run(
              "UPDATE turns SET ended_at = ?, end_reason = ? WHERE id = ? AND bot = ? AND ended_at IS NULL",
              [entry.at, entry.event.reason, entry.turn, entry.bot],
            );
          }
          return {
            id,
            position,
            bot: entry.bot,
            turn: entry.turn,
            format: eventFormat,
            event: entry.event,
            at: entry.at,
          };
        });
      });

    const cancelTimer = Effect.suspend(() => {
      const waiting = timer;
      timer = undefined;
      return waiting === undefined
        ? Effect.void
        : Fiber.interrupt(waiting).pipe(Effect.asVoid);
    });

    const flush: Effect.Effect<void> = Effect.suspend(() => {
      if (pending.length === 0) return Effect.void;
      const batch = pending.slice(0, maxBatch);
      const outcome = Effect.try(() => write(batch));
      return outcome.pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              retrying = true;
              logger.error(
                "saving bot events failed, so the server will retry",
                {
                  error:
                    error.cause instanceof Error ? error.cause.name : "unknown",
                },
              );
            }).pipe(Effect.andThen(arm(retryAfter))),
          onSuccess: (saved) => {
            retrying = false;
            pending = pending.slice(batch.length);
            return PubSub.publishAll(live, saved).pipe(
              Effect.andThen(
                pending.length === 0
                  ? Effect.void
                  : Effect.suspend(() => flush),
              ),
            );
          },
        }),
      );
    });

    const arm = (after: Duration.Input): Effect.Effect<void> =>
      cancelTimer.pipe(
        Effect.andThen(
          Effect.sleep(after).pipe(
            Effect.andThen(
              Effect.sync(() => {
                timer = undefined;
              }),
            ),
            Effect.andThen(flush),
            Effect.forkIn(scope),
            Effect.tap((fiber) =>
              Effect.sync(() => {
                timer = fiber;
              }),
            ),
            Effect.asVoid,
          ),
        ),
      );

    yield* Effect.addFinalizer(() =>
      cancelTimer.pipe(
        Effect.andThen(flush),
        Effect.andThen(
          Effect.sync(() => {
            if (pending.length > 0) {
              logger.error("bot events were not saved at shutdown", {
                count: pending.length,
              });
            }
          }),
        ),
      ),
    );

    const record = (entry: NewEvent) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.suspend(() => {
          pending.push({ ...entry, at });
          if (retrying) return Effect.void;
          if (pending.length >= maxBatch)
            return cancelTimer.pipe(Effect.andThen(flush));
          return timer === undefined ? arm(window) : Effect.void;
        }),
      );

    const appendNow = (entries: readonly NewEvent[]) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Effect.suspend(() => {
          if (entries.length === 0) return Effect.void;
          const saved = write(entries.map((entry) => ({ ...entry, at })));
          return Effect.asVoid(PubSub.publishAll(live, saved));
        }),
      );

    const read = (after: number, limit: number) =>
      db
        .all(
          `SELECT ${columns} FROM events WHERE position > ? ORDER BY position LIMIT ?`,
          [after, limit],
        )
        .map(decodeEvent);

    const turnEvents = (turn: string) =>
      db
        .all(`SELECT ${columns} FROM events WHERE turn = ? ORDER BY position`, [
          turn,
        ])
        .map(decodeEvent);

    const store: EventStore = {
      serverId,
      streamId: readStreamId(db),
      head,
      firstKept,
      read,
      turnEvents,
      subscribe: PubSub.subscribe(live),
      record,
      appendNow,
      flush: cancelTimer.pipe(Effect.andThen(flush)),
    };
    return store;
  });
