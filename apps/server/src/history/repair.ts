import { turnId } from "@aphelion/plugin-sdk";
import { Effect } from "effect";
import { streamTracker } from "../bots/stream";
import type { Database } from "../store";
import type { EventStore, NewEvent } from "./event-store";

export const closeDanglingTurns = (db: Database, store: EventStore) =>
  Effect.gen(function* () {
    const open = db.all(
      "SELECT id, bot FROM turns WHERE ended_at IS NULL ORDER BY started_at, id",
    );
    const repairs: NewEvent[] = [];
    for (const { id, bot } of open) {
      const turn = turnId.parse(id);
      const tracker = streamTracker();
      store.turnEvents(turn).forEach((saved, index) => {
        tracker.observe({
          seq: index + 1,
          turn: saved.turn === null ? null : turnId.parse(saved.turn),
          event: saved.event,
        });
      });
      tracker.begin(turn);
      for (const repair of tracker.repair()) {
        repairs.push({
          bot: String(bot),
          turn: repair.turn,
          event: repair.event,
        });
      }
    }
    yield* store.appendNow(repairs);
    return open.length;
  });
