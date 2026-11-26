import { streamEvent } from "@aphelion/plugin-sdk";
import { botEvent } from "@aphelion/protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const samples = [
  { type: "session", ref: "s-1" },
  { type: "text.delta", text: "hello" },
  { type: "tool.start", call: "c1", tool: "Bash", kind: "shell" },
  { type: "tool.end", call: "c1", outcome: "cancelled" },
  {
    type: "usage",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: null,
  },
  { type: "error", code: "cli-exited" },
  { type: "turn.end", reason: "error" },
  {
    type: "permission.request",
    request: "r1",
    call: null,
    tool: "Bash",
    kind: "shell",
    pathCount: 0,
    hasCommand: true,
  },
  {
    type: "permission.decision",
    request: "r1",
    decision: "deny",
    by: "default",
    reason: "shutdown",
  },
];

const structure = (schema: z.ZodType) =>
  z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    metadata: z.registry(),
  });

const kindOf = (option: z.ZodType) => {
  const shape = (option as z.ZodObject).shape as { type: z.ZodLiteral<string> };
  return shape.type.value;
};

const sdkOptions = streamEvent.options as readonly z.ZodType[];
const protocolOptions = botEvent.options as readonly z.ZodType[];

describe("the protocol's bot events and the adapter's stream events", () => {
  test("have the same kinds", () => {
    expect(protocolOptions.map(kindOf).toSorted()).toEqual(
      sdkOptions.map(kindOf).toSorted(),
    );
  });

  test.each(sdkOptions.map((option) => [kindOf(option), option] as const))(
    "describe %s with the same fields, types and limits",
    (kind, option) => {
      const match = protocolOptions.find((other) => kindOf(other) === kind);

      expect(match).toBeDefined();
      expect(structure(match as z.ZodType)).toEqual(structure(option));
    },
  );

  test("have a sample for every kind", () => {
    expect(samples.map(({ type }) => type).toSorted()).toEqual(
      sdkOptions.map(kindOf).toSorted(),
    );
  });

  test.each(samples.map((sample) => [sample.type, sample] as const))(
    "carry %s from the adapter to the protocol and back unchanged",
    (_, sample) => {
      const fromAdapter = streamEvent.parse(sample);
      const inProtocol = botEvent.parse(fromAdapter);

      expect(inProtocol).toEqual(sample);
      expect(streamEvent.parse(inProtocol)).toEqual(sample);
    },
  );

  test.each([
    ["text over 16 KiB", { type: "text.delta", text: "a".repeat(16385) }],
    ["empty text", { type: "text.delta", text: "" }],
    [
      "a call id with a space",
      { type: "tool.end", call: "a b", outcome: "ok" },
    ],
    ["a session ref with a slash", { type: "session", ref: "a/b" }],
    ["an unknown reason", { type: "turn.end", reason: "tired" }],
    ["a path count over 32", { ...samples[7], pathCount: 33 }],
  ])("refuse %s on both sides", (_, event) => {
    expect(streamEvent.safeParse(event).success).toBe(false);
    expect(botEvent.safeParse(event).success).toBe(false);
  });
});
