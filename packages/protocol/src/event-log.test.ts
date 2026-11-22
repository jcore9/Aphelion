import { describe, expect, test } from "vitest";
import {
  EventLog,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
  streamId,
  type Cursor,
  type EventFrame,
} from "./index";

const stream = streamId.parse("s1");

function logWith(count: number, capacity = 100) {
  const log = new EventLog({ stream, capacity });
  for (let n = 1; n <= count; n++) {
    log.append({ name: "notice", payload: { message: `event ${String(n)}` } });
  }
  return log;
}

const seqs = (frames: readonly { type: string }[]) =>
  frames.map((frame) => (frame as EventFrame).seq);

describe("replay from a cursor", () => {
  test("numbers events from 1, increasing by one", () => {
    const log = new EventLog({ stream, capacity: 10 });
    const first = log.append({ name: "notice", payload: { message: "a" } });
    const second = log.append({ name: "notice", payload: { message: "b" } });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(log.head).toEqual({ stream, seq: 2 });
  });

  test("replays the events after the cursor, in order", () => {
    const replay = logWith(5).resume({ stream, seq: 2 });
    expect(seqs(replay)).toEqual([3, 4, 5]);
    expect(replay[0]).toEqual({
      v: 1,
      type: "event",
      seq: 3,
      name: "notice",
      payload: { message: "event 3" },
    });
  });

  test("replays nothing to a client that has every event", () => {
    expect(logWith(5).resume({ stream, seq: 5 })).toEqual([]);
  });

  test("replays everything kept to a cursor at the edge of the window", () => {
    const log = logWith(10, 4);
    expect(seqs(log.resume({ stream, seq: 6 }))).toEqual([7, 8, 9, 10]);
  });

  test.each<[string, Cursor | null]>([
    ["older than the window", { stream, seq: 5 }],
    ["ahead of the server", { stream, seq: 11 }],
    ["from another stream", { stream: streamId.parse("s0"), seq: 8 }],
    ["missing", null],
  ])("tells a client whose cursor is %s to resync", (_, cursor) => {
    expect(logWith(10, 4).resume(cursor)).toEqual([
      { v: 1, type: "resync", cursor: { stream, seq: 10 } },
    ]);
  });
});

test("a client that reconnects with its last sequence number gets what it missed", () => {
  const server = new EventLog({ stream, capacity: 100 });
  const client = { cursor: null as Cursor | null, messages: [] as string[] };

  const deliver = (frames: readonly object[]) => {
    for (const frame of frames) {
      const parsed = parseServerFrame(JSON.stringify(frame));
      if (!parsed.ok) throw new Error(parsed.error.message);
      if (parsed.frame.type === "resync") client.cursor = parsed.frame.cursor;
      if (parsed.frame.type === "event" && client.cursor) {
        client.messages.push(parsed.frame.payload.message);
        client.cursor = { ...client.cursor, seq: parsed.frame.seq };
      }
    }
  };
  const reconnect = () => {
    const parsed = parseClientFrame(
      encodeFrame({ v: 1, type: "resume", cursor: client.cursor }),
    );
    if (!parsed.ok || parsed.frame.type !== "resume")
      throw new Error("bad resume");
    deliver(server.resume(parsed.frame.cursor));
  };
  const publish = (message: string) =>
    server.append({ name: "notice", payload: { message } });

  reconnect();
  deliver([publish("one"), publish("two")]);
  publish("three");
  publish("four");
  reconnect();
  deliver([publish("five")]);

  expect(client.messages).toEqual(["one", "two", "three", "four", "five"]);
  expect(client.cursor).toEqual({ stream, seq: 5 });
});
