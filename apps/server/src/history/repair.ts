import { toolCallId, turnId } from "@aphelion/plugin-sdk";
import { Effect } from "effect";
import { streamTracker } from "../bots/stream";
import type { Database } from "../store";
import type { EventStore, NewEvent } from "./event-store";

const callKey = (bot: string, run: number, call: string) =>
  `${bot}\u0000${String(run)}\u0000${call}`;

interface OpenCall {
  readonly bot: string;
  readonly run: number;
  readonly turn: string | null;
  readonly call: string;
}

const openCalls = (db: Database): Map<string, OpenCall> => {
  const open = new Map<string, OpenCall>();
  const rows = db.all(
    "SELECT bot, run, turn, kind, json_extract(payload, '$.call') AS call FROM events WHERE kind IN ('tool.start', 'tool.end') ORDER BY position",
  );
  for (const row of rows) {
    const bot = String(row["bot"]);
    const run = Number(row["run"]);
    const call = String(row["call"]);
    const key = callKey(bot, run, call);
    if (row["kind"] === "tool.end") {
      open.delete(key);
    } else {
      open.set(key, {
        bot,
        run,
        turn: row["turn"] === null ? null : String(row["turn"]),
        call,
      });
    }
  }
  return open;
};

export const closeDanglingTurns = (db: Database, store: EventStore) =>
  Effect.gen(function* () {
    const open = db.all(
      "SELECT id, bot FROM turns WHERE ended_at IS NULL ORDER BY started_at, id",
    );
    const repairs: NewEvent[] = [];
    const calls = openCalls(db);
    for (const { id, bot } of open) {
      const turn = turnId.parse(id);
      const tracker = streamTracker();
      const saved = store.turnEvents(turn);
      saved.forEach((event, index) => {
        tracker.observe({
          seq: index + 1,
          turn: event.turn === null ? null : turnId.parse(event.turn),
          event: event.event,
        });
      });
      tracker.begin(turn);
      const run = saved.at(-1)?.run ?? 1;
      for (const repair of tracker.repair()) {
        if (repair.event.type === "tool.end") {
          calls.delete(callKey(String(bot), run, repair.event.call));
        }
        repairs.push({
          bot: String(bot),
          run,
          turn: repair.turn,
          event: repair.event,
        });
      }
    }
    const strays = [...calls.values()];
    for (const { bot, run, turn, call } of strays) {
      repairs.push({
        bot,
        run,
        turn,
        event: {
          type: "tool.end",
          call: toolCallId.parse(call),
          outcome: "cancelled",
        },
      });
    }
    yield* store.appendNow(repairs);
    return { turns: open.length, calls: strays.length };
  });
