import { expect, test, vi } from "vitest";
import { decodeEvent, UnreadableEventError } from "./saved-event";

vi.mock("@aphelion/plugin-sdk", () => {
  throw new Error("reading a saved event must not load the adapter SDK");
});

const row = (kind: string, payload: string, format = 1) => ({
  id: "0192f0a0-0000-7000-8000-000000000001",
  position: 7,
  bot: "chief",
  turn: kind === "session" ? null : "0192f0a1-3b7d-7c5e-9a21-0d4e6f8a1b23",
  run: 1,
  epoch: 1,
  format,
  kind,
  payload,
  at: 1_764_000_000_000,
});

const golden: readonly (readonly [string, string, object])[] = [
  [
    "session",
    '{"ref":"6f0c2c9e-1b7a-4d1c-9a41-7e3f5a0b2d11"}',
    { ref: "6f0c2c9e-1b7a-4d1c-9a41-7e3f5a0b2d11" },
  ],
  ["text.delta", '{"text":"Hello, é€😀"}', { text: "Hello, é€😀" }],
  [
    "tool.start",
    '{"call":"toolu_01A","tool":"Bash","kind":"shell"}',
    { call: "toolu_01A", tool: "Bash", kind: "shell" },
  ],
  [
    "tool.end",
    '{"call":"toolu_01A","outcome":"cancelled"}',
    { call: "toolu_01A", outcome: "cancelled" },
  ],
  [
    "usage",
    '{"inputTokens":12,"outputTokens":34,"cacheReadTokens":5,"cacheWriteTokens":6,"costUsd":null}',
    {
      inputTokens: 12,
      outputTokens: 34,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
      costUsd: null,
    },
  ],
  ["error", '{"code":"cli-exited"}', { code: "cli-exited" }],
  ["turn.end", '{"reason":"completed"}', { reason: "completed" }],
  [
    "permission.request",
    '{"request":"r1","call":null,"tool":"Bash","kind":"shell","pathCount":2,"hasCommand":true}',
    {
      request: "r1",
      call: null,
      tool: "Bash",
      kind: "shell",
      pathCount: 2,
      hasCommand: true,
    },
  ],
  [
    "permission.decision",
    '{"request":"r1","decision":"deny","by":"default","reason":"shutdown"}',
    { request: "r1", decision: "deny", by: "default", reason: "shutdown" },
  ],
];

test.each(golden)(
  "still decodes a saved M1 %s row, with no help from the adapter SDK",
  (kind, payload, fields) => {
    expect(decodeEvent(row(kind, payload)).event).toEqual({
      type: kind,
      ...fields,
    });
  },
);

test("covers every event kind the format has", () => {
  expect(golden.map(([kind]) => kind)).toHaveLength(9);
});

test("refuses a row that doesn't match format 1, and a format it doesn't know", () => {
  expect(() => decodeEvent(row("turn.end", '{"reason":"tired"}'))).toThrow(
    UnreadableEventError,
  );
  expect(() => decodeEvent(row("turn.end", '{"reason":"error"}', 2))).toThrow(
    UnreadableEventError,
  );
});
