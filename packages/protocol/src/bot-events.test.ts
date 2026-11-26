import { describe, expect, test } from "vitest";
import { encodeFrame, parseServerFrame, type ServerFrame } from "./index.ts";

const frame = (payload: unknown, seq = 3) =>
  encodeFrame({
    v: 1,
    type: "event",
    seq,
    name: "bot.event",
    payload,
  } as ServerFrame);

const payload = (event: unknown, extra: Record<string, unknown> = {}) => ({
  bot: "chief",
  turn: "t1",
  format: 1,
  event,
  ...extra,
});

describe("the bot.event frame", () => {
  test("carries a bot's event with its turn and format", () => {
    const body = payload({ type: "text.delta", text: "hi" });

    expect(parseServerFrame(frame(body))).toEqual({
      ok: true,
      frame: { v: 1, type: "event", seq: 3, name: "bot.event", payload: body },
    });
  });

  test("allows no turn for an error outside a turn", () => {
    const body = payload({ type: "error", code: "cli-exited" }, { turn: null });

    expect(parseServerFrame(frame(body)).ok).toBe(true);
  });

  test("has no session event, so a client never gets the vendor's session ref", () => {
    const body = payload({ type: "session", ref: "s-1" }, { turn: null });

    expect(parseServerFrame(frame(body)).ok).toBe(false);
  });

  test.each([
    ["a bot name with capitals", payload({ type: "usage" }, { bot: "Chief" })],
    [
      "a format of 0",
      payload({ type: "error", code: "vendor" }, { format: 0 }),
    ],
    ["an unknown event type", payload({ type: "thinking", text: "hm" })],
    [
      "a field the event doesn't define",
      payload({ type: "error", code: "vendor", detail: "x" }),
    ],
    ["a text delta with no text", payload({ type: "text.delta", text: "" })],
    [
      "a text delta over 16 KiB",
      payload({ type: "text.delta", text: "a".repeat(16 * 1024 + 1) }),
    ],
    [
      "a field the payload doesn't define",
      payload({ type: "turn.end", reason: "completed" }, { session: "s" }),
    ],
  ])("rejects %s", (_, body) => {
    expect(parseServerFrame(frame(body)).ok).toBe(false);
  });

  test("accepts a text delta of exactly 16 KiB, counted in bytes", () => {
    const text = "é".repeat(8 * 1024);
    expect(
      parseServerFrame(frame(payload({ type: "text.delta", text }))).ok,
    ).toBe(true);
    expect(
      parseServerFrame(frame(payload({ type: "text.delta", text: `${text}a` })))
        .ok,
    ).toBe(false);
  });
});
