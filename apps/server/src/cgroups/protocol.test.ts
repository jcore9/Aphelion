import { describe, expect, it } from "vitest";
import { maxSupervisorFrameBytes, supervisorRequestSchema } from "./protocol";

const start = {
  type: "start",
  run: "0197a3c2-5f1e-7a2b-8c3d-4e5f60718293",
  bot: "alpha",
  adapter: "claude",
  folder: "/var/lib/aphelion-bots/alpha",
};

const accepts = (frame: unknown) =>
  supervisorRequestSchema.safeParse(frame).success;

describe("the supervisor's start request", () => {
  it("takes an optional API key of up to 512 printable ASCII bytes", () => {
    expect(accepts(start)).toBe(true);
    expect(accepts({ ...start, apiKey: "sk-ant-fake-supervisor" })).toBe(true);
    expect(accepts({ ...start, apiKey: "a".repeat(513) })).toBe(false);
    expect(accepts({ ...start, apiKey: "sk-ant-fake\nX=1" })).toBe(false);
    expect(accepts({ ...start, apiKey: "" })).toBe(false);
  });

  it("fits in a frame with the longest folder the runner sends and the longest key", () => {
    const frame = {
      ...start,
      run: "r".repeat(64),
      bot: "b".repeat(64),
      adapter: "a".repeat(64),
      folder: `/${"\\".repeat(4095)}`,
      apiKey: "\\".repeat(512),
    };
    expect(accepts(frame)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(
      maxSupervisorFrameBytes,
    );
  });
});
