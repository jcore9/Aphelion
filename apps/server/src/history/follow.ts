import {
  streamId,
  version,
  type Cursor,
  type EventFrame,
  type ResyncFrame,
} from "@aphelion/protocol";
import { Effect, PubSub } from "effect";
import type { EventLog } from "./event-store";
import type { SavedEvent } from "./saved-event";

export const replayPage = 500;

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
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const live = yield* log.subscribe;
      const stream = streamId.parse(log.serverId);
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

      let last = cursor.seq;
      for (let page = log.read(last, replayPage); page.length > 0;) {
        for (const saved of page) {
          yield* send(eventFrame(saved));
          last = saved.position;
        }
        page = page.length < replayPage ? [] : log.read(last, replayPage);
      }
      for (;;) {
        const saved = yield* PubSub.take(live);
        if (saved.position <= last) continue;
        yield* send(eventFrame(saved));
        last = saved.position;
      }
    }),
  );
