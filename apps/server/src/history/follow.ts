import {
  streamId,
  version,
  type Cursor,
  type EventFrame,
  type ResyncFrame,
} from "@aphelion/protocol";
import { Data, Effect, PubSub, Queue } from "effect";
import type { EventLog } from "./event-store";
import type { SavedEvent } from "./saved-event";

export const replayPage = 500;
export const liveBufferLimit = 5000;

export class LiveBufferFullError extends Data.TaggedError(
  "LiveBufferFullError",
) {}

export const eventFrame = ({
  position,
  bot,
  turn,
  format,
  event,
}: SavedEvent): EventFrame => ({
  v: version,
  type: "event",
  seq: position,
  name: "bot.event",
  payload: { bot, turn, format, event },
});

export const follow = <E>(
  log: EventLog,
  cursor: Cursor | null,
  send: (frame: EventFrame | ResyncFrame) => Effect.Effect<void, E>,
  limit: number = liveBufferLimit,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscription = yield* log.subscribe;
      const live = yield* Queue.unbounded<SavedEvent>();
      const pump = Effect.forever(
        PubSub.take(subscription).pipe(
          Effect.tap((saved) => Queue.offer(live, saved)),
          Effect.andThen(Queue.size(live)),
          Effect.flatMap((size) =>
            size > limit ? Effect.fail(new LiveBufferFullError()) : Effect.void,
          ),
        ),
      );
      const stream = streamId.parse(log.streamId);
      const head = log.head();
      if (
        cursor === null ||
        cursor.stream !== stream ||
        cursor.seq > head ||
        cursor.seq < log.firstKept() - 1
      ) {
        return yield* send({
          v: version,
          type: "resync",
          cursor: { stream, seq: head },
        });
      }

      const replayThenLive = Effect.gen(function* () {
        let last = cursor.seq;
        for (let page = log.read(last, replayPage); page.length > 0;) {
          for (const saved of page) {
            yield* send(eventFrame(saved));
            last = saved.position;
          }
          page = page.length < replayPage ? [] : log.read(last, replayPage);
        }
        for (;;) {
          const saved = yield* Queue.take(live);
          if (saved.position <= last) continue;
          yield* send(eventFrame(saved));
          last = saved.position;
        }
      });
      return yield* Effect.raceFirst(replayThenLive, pump);
    }),
  );
