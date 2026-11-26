import { describe, expect, test } from "vitest";
import {
  adapterEnvelope,
  streamEvent,
  type AdapterEnvelope,
} from "./adapter.ts";
import { checkStream } from "./adapter-check.ts";

type Row = readonly [turn: string | null, event: Record<string, unknown>];

const stream = (rows: readonly Row[], firstSeq = 1): AdapterEnvelope[] =>
  rows.map(([turn, event], index) =>
    adapterEnvelope.parse({
      seq: firstSeq + index,
      turn,
      event: streamEvent.parse(event),
    }),
  );

const rules = (rows: readonly Row[], firstSeq = 1) =>
  checkStream(stream(rows, firstSeq)).map(({ rule }) => rule);

const start = (call: string): Row["1"] => ({
  type: "tool.start",
  call,
  tool: "Bash",
  kind: "shell",
});
const end = (call: string, outcome = "ok"): Row["1"] => ({
  type: "tool.end",
  call,
  outcome,
});
const done: Row["1"] = { type: "turn.end", reason: "completed" };
const text: Row["1"] = { type: "text.delta", text: "hi" };
const ask = (request: string, call: string | null = null): Row["1"] => ({
  type: "permission.request",
  request,
  call,
  tool: "Bash",
  kind: "shell",
  pathCount: 0,
  hasCommand: true,
});
const decide = (request: string, decision = "allow"): Row["1"] => ({
  type: "permission.decision",
  request,
  decision,
  by: "rule",
  reason: "inside-folder",
});
const usage: Row["1"] = {
  type: "usage",
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
};

describe("rule 1: seq counts up by 1 from 1", () => {
  test("accepts a stream that starts at 1 and has no gaps", () => {
    expect(
      rules([
        ["t1", text],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("accepts an empty stream", () => {
    expect(rules([])).toEqual([]);
  });
  test("refuses a stream that starts at 2", () => {
    expect(
      rules(
        [
          ["t1", text],
          ["t1", done],
        ],
        2,
      ),
    ).toContain(1);
  });
  test("refuses a gap", () => {
    const events = stream([
      ["t1", text],
      ["t1", text],
      ["t1", done],
    ]);
    const gap = [events[0], events[2]].filter((event) => event !== undefined);
    expect(checkStream(gap).map(({ rule }) => rule)).toContain(1);
  });
  test("refuses a repeated seq", () => {
    const events = stream([
      ["t1", text],
      ["t1", done],
    ]);
    const first = events[0];
    if (!first) throw new Error("no event");
    expect(
      checkStream([first, { ...first, turn: first.turn }]).map(
        ({ rule }) => rule,
      ),
    ).toContain(1);
  });
});

describe("rule 2: events with a turn id belong to that turn", () => {
  test("accepts a session event and an error outside a turn between a turn's events", () => {
    expect(
      rules([
        ["t1", text],
        [null, { type: "session", ref: "s1" }],
        [null, { type: "error", code: "cli-exited" }],
        [null, { type: "session", ref: "s2" }],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("accepts two turns one after the other", () => {
    expect(
      rules([
        ["t1", text],
        ["t1", done],
        ["t2", text],
        ["t2", done],
      ]),
    ).toEqual([]);
  });
  test("refuses an event of another turn while a turn runs", () => {
    expect(
      rules([
        ["t1", text],
        ["t2", text],
        ["t2", done],
        ["t1", done],
      ]),
    ).toContain(2);
  });
  test("refuses a tool.end that names a different turn than its tool.start", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
        ["t2", text],
        ["t2", end("c1")],
        ["t2", done],
      ]),
    ).toContain(2);
  });
});

describe("rule 3: one turn.end per turn, and nothing but a late tool.end after it", () => {
  test("accepts a tool.end after its turn ended, for a call the turn started", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
        ["t1", end("c1")],
      ]),
    ).toEqual([]);
  });
  test("accepts that late tool.end while a later turn runs", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
        ["t2", text],
        ["t1", end("c1")],
        ["t2", done],
      ]),
    ).toEqual([]);
  });
  test("refuses a turn without a turn.end", () => {
    expect(rules([["t1", text]])).toEqual([3]);
  });
  test("refuses two turn.end events", () => {
    expect(
      rules([
        ["t1", done],
        ["t1", done],
      ]),
    ).toContain(3);
  });
  test("refuses a text delta after turn.end", () => {
    expect(
      rules([
        ["t1", done],
        ["t1", text],
      ]),
    ).toContain(3);
  });
  test("refuses a tool.end after turn.end for a call another turn started", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
        ["t2", text],
        ["t2", done],
        ["t2", end("c1")],
      ]),
    ).toContain(3);
  });
});

describe("rule 4: a tool.start has at most one tool.end, and a tool.end needs a start", () => {
  test("accepts a call that never ends", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("accepts a call that ends once, in its turn", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("refuses a tool.end without a tool.start", () => {
    expect(
      rules([
        ["t1", end("c1")],
        ["t1", done],
      ]),
    ).toEqual([4]);
  });
  test("refuses a tool.end that comes before its tool.start", () => {
    expect(
      rules([
        ["t1", end("c1")],
        ["t1", start("c1")],
        ["t1", done],
      ]),
    ).toContain(4);
  });
  test("refuses two tool.end events for one call, even after the turn ended", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1")],
        ["t1", done],
        ["t1", end("c1")],
      ]),
    ).toContain(4);
  });
});

describe("rule 5: each permission.request has one decision before turn.end", () => {
  test("accepts a request, its decision and the end", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", decide("r1")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("accepts two requests decided in the other order", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", ask("r2")],
        ["t1", decide("r2")],
        ["t1", decide("r1")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("refuses a request with no decision", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", done],
      ]),
    ).toEqual([5]);
  });
  test("refuses two decisions for one request", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", decide("r1")],
        ["t1", decide("r1", "deny")],
        ["t1", done],
      ]),
    ).toContain(5);
  });
  test("refuses a decision with no request", () => {
    expect(
      rules([
        ["t1", decide("r1")],
        ["t1", done],
      ]),
    ).toEqual([5]);
  });
  test("refuses a decision after turn.end", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", done],
        ["t1", decide("r1")],
      ]),
    ).toContain(5);
  });
});

describe("rule 6: a denied tool.end follows a deny decision in the same turn", () => {
  test("accepts a deny for that call", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", ask("r1", "c1")],
        ["t1", decide("r1", "deny")],
        ["t1", end("c1", "denied")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("accepts a deny with call null", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", ask("r1", null)],
        ["t1", decide("r1", "deny")],
        ["t1", end("c1", "denied")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });
  test("refuses a denied end with no decision", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1", "denied")],
        ["t1", done],
      ]),
    ).toEqual([6]);
  });
  test("refuses a denied end after an allow", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", ask("r1", "c1")],
        ["t1", decide("r1", "allow")],
        ["t1", end("c1", "denied")],
        ["t1", done],
      ]),
    ).toEqual([6]);
  });
  test("refuses a deny for another call", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", start("c2")],
        ["t1", ask("r1", "c2")],
        ["t1", decide("r1", "deny")],
        ["t1", end("c1", "denied")],
        ["t1", done],
      ]),
    ).toEqual([6]);
  });
  test("refuses a deny from an earlier turn", () => {
    expect(
      rules([
        ["t1", ask("r1")],
        ["t1", decide("r1", "deny")],
        ["t1", done],
        ["t2", start("c1")],
        ["t2", end("c1", "denied")],
        ["t2", done],
      ]),
    ).toEqual([6]);
  });
  test("refuses a deny that comes after the denied end", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1", "denied")],
        ["t1", ask("r1", "c1")],
        ["t1", decide("r1", "deny")],
        ["t1", done],
      ]),
    ).toEqual([6]);
  });
});

describe("rule 7: at most one usage per turn", () => {
  test("accepts one usage in each of two turns", () => {
    expect(
      rules([
        ["t1", usage],
        ["t1", done],
        ["t2", usage],
        ["t2", done],
      ]),
    ).toEqual([]);
  });
  test("refuses two usages in one turn", () => {
    expect(
      rules([
        ["t1", usage],
        ["t1", usage],
        ["t1", done],
      ]),
    ).toEqual([7]);
  });
});

test("a violation names ids and numbers only", () => {
  const [violation] = checkStream(
    stream([
      ["t1", ask("r-secret-1")],
      ["t1", done],
    ]),
  );
  expect(violation?.message).toBe(
    "request r-secret-1 in turn t1 has no decision",
  );
});

describe("calls and events that can't be trusted", () => {
  test("a second tool.start for a call id seen before breaks rule 4", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1")],
        ["t1", start("c1")],
        ["t1", end("c1")],
        ["t1", done],
      ]),
    ).toEqual([4, 4]);
  });

  test("a call id started in another turn breaks rule 4 too", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", done],
        ["t2", start("c1")],
        ["t2", done],
      ]),
    ).toEqual([4]);
  });

  test("distinct call ids pass", () => {
    expect(
      rules([
        ["t1", start("c1")],
        ["t1", end("c1")],
        ["t1", start("c2")],
        ["t1", end("c2")],
        ["t1", done],
      ]),
    ).toEqual([]);
  });

  test("an event that fails its schema is reported, and is not checked further", () => {
    const bad = [
      { seq: 1, turn: "t1", event: { type: "text.delta", text: "" } },
      { seq: 2, turn: "t1", event: { type: "turn.end", reason: "completed" } },
    ] as unknown as AdapterEnvelope[];
    expect(checkStream(bad).map(({ rule }) => rule)).toEqual([0]);
  });

  test("an event with no turn that isn't session or error is reported", () => {
    const bad = [
      {
        seq: 1,
        turn: null,
        event: { type: "tool.start", call: "c1", tool: "Bash", kind: "shell" },
      },
    ] as unknown as AdapterEnvelope[];
    expect(checkStream(bad).map(({ rule }) => rule)).toEqual([0]);
  });
});
