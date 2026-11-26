import {
  adapterEnvelope,
  turnId,
  type AdapterEnvelope,
} from "@aphelion/plugin-sdk";
import { checkStream } from "@aphelion/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { streamTracker } from "./stream";

const envelopes = (raw: readonly unknown[]): AdapterEnvelope[] =>
  raw.map((item) => adapterEnvelope.parse(item));

const watch = (raw: readonly unknown[]) => {
  const tracker = streamTracker();
  const events = envelopes(raw);
  for (const envelope of events) tracker.observe(envelope);
  return { tracker, events };
};

const midTurn = [
  { seq: 1, turn: null, event: { type: "session", ref: "s-1" } },
  {
    seq: 2,
    turn: "t1",
    event: { type: "tool.start", call: "c1", tool: "Bash", kind: "shell" },
  },
  {
    seq: 3,
    turn: "t1",
    event: {
      type: "permission.request",
      request: "r1",
      call: "c1",
      tool: "Bash",
      kind: "shell",
      pathCount: 0,
      hasCommand: true,
    },
  },
  { seq: 4, turn: "t1", event: { type: "text.delta", text: "working" } },
];

describe("the stream repair", () => {
  it("ends a turn cut off mid-call the way the adapter wire says, and the result passes checkStream", () => {
    const { tracker, events } = watch(midTurn);
    expect(checkStream(events)).not.toEqual([]);
    const repaired = tracker.repair();
    expect(repaired).toEqual([
      { seq: 5, turn: "t1", event: { type: "error", code: "cli-exited" } },
      {
        seq: 6,
        turn: "t1",
        event: {
          type: "permission.decision",
          request: "r1",
          decision: "deny",
          by: "default",
          reason: "shutdown",
        },
      },
      {
        seq: 7,
        turn: "t1",
        event: { type: "tool.end", call: "c1", outcome: "cancelled" },
      },
      { seq: 8, turn: "t1", event: { type: "turn.end", reason: "error" } },
    ]);
    expect(checkStream([...events, ...repaired])).toEqual([]);
  });

  it("cancels a background call of an ended turn under that turn, while it ends the open one", () => {
    const { tracker, events } = watch([
      {
        seq: 1,
        turn: "t1",
        event: { type: "tool.start", call: "bg", tool: "Bash", kind: "shell" },
      },
      { seq: 2, turn: "t1", event: { type: "turn.end", reason: "completed" } },
      { seq: 3, turn: "t2", event: { type: "text.delta", text: "next" } },
    ]);
    const repaired = tracker.repair();
    expect(repaired.map(({ turn, event }) => [turn, event.type])).toEqual([
      ["t2", "error"],
      ["t1", "tool.end"],
      ["t2", "turn.end"],
    ]);
    expect(checkStream([...events, ...repaired])).toEqual([]);
  });

  it("ends a turn the adapter accepted before it sent any event", () => {
    const { tracker, events } = watch([
      { seq: 1, turn: null, event: { type: "session", ref: "s-1" } },
    ]);
    tracker.begin(turnId.parse("t9"));
    const repaired = tracker.repair();
    expect(repaired.map(({ turn, event }) => [turn, event.type])).toEqual([
      ["t9", "error"],
      ["t9", "turn.end"],
    ]);
    expect(checkStream([...events, ...repaired])).toEqual([]);
  });

  it("adds nothing when the process dies between turns with no call open", () => {
    const { tracker } = watch([
      { seq: 1, turn: "t1", event: { type: "turn.end", reason: "completed" } },
    ]);
    expect(tracker.repair()).toEqual([]);
  });

  it("repairs a stream once, so a second repair adds nothing", () => {
    const { tracker } = watch(midTurn);
    expect(tracker.repair()).toHaveLength(4);
    expect(tracker.repair()).toEqual([]);
  });
});
