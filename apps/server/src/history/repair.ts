import { toolCallId, turnId } from "@aphelion/plugin-sdk";
import { Effect } from "effect";
import { streamTracker } from "../bots/stream";
import type { Logger } from "../log";
import type { Database, Row } from "../store";
import { eventColumns, type EventStore, type NewEvent } from "./event-store";
import { decodeEvent, type SavedEvent } from "./saved-event";

const callKey = (bot: string, epoch: number, run: number, call: string) =>
  `${bot}\u0000${String(epoch)}\u0000${String(run)}\u0000${call}`;

interface OpenCall {
  readonly bot: string;
  readonly epoch: number;
  readonly run: number;
  readonly turn: string | null;
  readonly call: string;
}

const decoder = (logger: Logger) => {
  const reported = new Set<string>();
  return (rows: readonly Row[]): SavedEvent[] =>
    rows.flatMap((row) => {
      try {
        return [decodeEvent(row)];
      } catch {
        const id = String(row["id"]);
        if (!reported.has(id)) {
          reported.add(id);
          logger.error("boot repair skipped a saved event it can't read", {
            id,
            format: Number(row["format"]),
          });
        }
        return [];
      }
    });
};

const openCalls = (
  db: Database,
  decode: ReturnType<typeof decoder>,
): Map<string, OpenCall> => {
  const open = new Map<string, OpenCall>();
  const rows = db.all(
    `SELECT ${eventColumns} FROM events WHERE kind IN ('tool.start', 'tool.end') ORDER BY position`,
  );
  for (const { bot, epoch, run, turn, event } of decode(rows)) {
    if (event.type === "tool.end") {
      open.delete(callKey(bot, epoch, run, event.call));
    } else if (event.type === "tool.start") {
      open.set(callKey(bot, epoch, run, event.call), {
        bot,
        epoch,
        run,
        turn,
        call: event.call,
      });
    }
  }
  return open;
};

export const closeDanglingTurns = (
  db: Database,
  store: EventStore,
  logger: Logger,
) =>
  Effect.gen(function* () {
    const decode = decoder(logger);
    const open = db.all(
      "SELECT id, bot FROM turns WHERE ended_at IS NULL ORDER BY started_at, id",
    );
    const repairs: NewEvent[] = [];
    const calls = openCalls(db, decode);
    for (const { id, bot } of open) {
      const turn = turnId.parse(id);
      const tracker = streamTracker();
      const saved = decode(
        db.all(
          `SELECT ${eventColumns} FROM events WHERE turn = ? ORDER BY position`,
          [turn],
        ),
      );
      saved.forEach((event, index) => {
        tracker.observe({
          seq: index + 1,
          turn: event.turn === null ? null : turnId.parse(event.turn),
          event: event.event,
        });
      });
      tracker.begin(turn);
      const last = saved.at(-1);
      const epoch = last?.epoch ?? store.epoch;
      const run = last?.run ?? 1;
      for (const repair of tracker.repair()) {
        if (repair.event.type === "tool.end") {
          calls.delete(callKey(String(bot), epoch, run, repair.event.call));
        }
        repairs.push({
          bot: String(bot),
          epoch,
          run,
          turn: repair.turn,
          event: repair.event,
        });
      }
    }
    const strays = [...calls.values()];
    for (const { bot, epoch, run, turn, call } of strays) {
      repairs.push({
        bot,
        epoch,
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
