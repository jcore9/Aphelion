import { describe, expect, it } from "vitest";
import { runnerReplySchema, runnerRequestSchema } from "./runner-protocol";

const start = {
  type: "start",
  bot: "chief-of-staff",
  run: 1,
  provider: "claude",
  adapter: "claude",
  folder: "/var/lib/aphelion-bots/chief-of-staff",
  resume: null,
};

const accepts = (frame: unknown) =>
  runnerRequestSchema.safeParse(frame).success;
const acceptsReply = (frame: unknown) =>
  runnerReplySchema.safeParse(frame).success;

describe("the bot runner's frames", () => {
  it("accepts a start with or without a session to resume, and refuses a ref that could be a path", () => {
    expect(accepts(start)).toBe(true);
    expect(
      accepts({ ...start, resume: "0b6f1c9e-7d1a-4c55-9a3e-5e2b8f0c1d22" }),
    ).toBe(true);
    expect(accepts({ ...start, resume: "../other-bot/session" })).toBe(false);
  });

  it("accepts a bot named by its config id, and refuses any other name", () => {
    expect(accepts({ ...start, bot: "triage" })).toBe(true);
    expect(accepts({ ...start, bot: "Triage" })).toBe(false);
    expect(accepts({ ...start, bot: "a/b" })).toBe(false);
  });

  it("names the adapter by its key in the supervisor's table, never by a path, and refuses a relative folder", () => {
    expect(
      accepts({
        ...start,
        adapter: "/usr/local/lib/aphelion/adapters/claude/adapter.js",
      }),
    ).toBe(false);
    expect(accepts({ ...start, adapter: "../claude" })).toBe(false);
    expect(accepts({ ...start, folder: "bots/chief-of-staff" })).toBe(false);
  });

  it("refuses a frame with a field it doesn't know", () => {
    expect(accepts({ type: "stop", bot: "triage", run: 1 })).toBe(true);
    expect(
      accepts({ type: "stop", bot: "triage", run: 1, target: "other" }),
    ).toBe(false);
  });

  it("accepts a prompt of 256 KiB and refuses a longer one", () => {
    const turn = { type: "turn.start", bot: "triage", run: 2, turn: "t1" };
    expect(accepts({ ...turn, text: "a".repeat(256 * 1024) })).toBe(true);
    expect(accepts({ ...turn, text: "a".repeat(256 * 1024 + 1) })).toBe(false);
    expect(accepts({ ...turn, text: "あ".repeat(90_000) })).toBe(false);
  });

  it("accepts an event that follows the adapter wire, and refuses one that doesn't", () => {
    const event = {
      type: "event",
      bot: "triage",
      run: 1,
      envelope: {
        seq: 1,
        turn: "t1",
        event: { type: "turn.end", reason: "completed" },
      },
    };
    expect(acceptsReply(event)).toBe(true);
    expect(
      acceptsReply({
        ...event,
        envelope: {
          seq: 1,
          turn: null,
          event: { type: "turn.end", reason: "completed" },
        },
      }),
    ).toBe(false);
    expect(
      acceptsReply({
        ...event,
        envelope: {
          ...event.envelope,
          event: { type: "shell", command: "rm -rf /" },
        },
      }),
    ).toBe(false);
  });
});
