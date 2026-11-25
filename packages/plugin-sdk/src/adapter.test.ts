import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  adapterEnvelope,
  adapterEvent,
  adapterInitializeParams,
  denyAll,
  permissionDecision,
  permissionRequest,
  permissionRequestId,
  sessionRef,
  streamEvent,
  toolCallId,
  turnCancelParams,
  turnId,
  turnStartParams,
} from "./adapter.ts";

const call = "toolu_01.a:b-c";

const goodEvents = [
  { type: "session", ref: "abc-123" },
  { type: "text.delta", text: "hello" },
  { type: "tool.start", call, tool: "Bash", kind: "shell" },
  { type: "tool.end", call, outcome: "cancelled" },
  {
    type: "usage",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
  },
  { type: "error", code: "rate-limited" },
  { type: "turn.end", reason: "denied" },
] as const;

const runtimeEvents = [
  {
    type: "permission.request",
    request: "r1",
    call: null,
    tool: "Read",
    kind: "file.read",
    pathCount: 2,
    hasCommand: false,
  },
  {
    type: "permission.decision",
    request: "r1",
    decision: "deny",
    by: "default",
    reason: "outside-folder",
  },
] as const;

describe("events", () => {
  test.each(goodEvents)("an adapter may yield $type", (event) => {
    expect(adapterEvent.safeParse(event).success).toBe(true);
    expect(streamEvent.safeParse(event).success).toBe(true);
  });

  test.each(runtimeEvents)("only the runtime sends $type", (event) => {
    expect(adapterEvent.safeParse(event).success).toBe(false);
    expect(streamEvent.safeParse(event).success).toBe(true);
  });

  const refused: [string, unknown][] = [
    ["an empty text delta", { type: "text.delta", text: "" }],
    [
      "a text delta over 16 KiB",
      { type: "text.delta", text: "a".repeat(16 * 1024 + 1) },
    ],
    [
      "a text delta over 16 KiB in bytes",
      { type: "text.delta", text: "é".repeat(8 * 1024 + 1) },
    ],
    ["a session ref with a newline", { type: "session", ref: "a\nb" }],
    [
      "a session ref over 256 characters",
      { type: "session", ref: "a".repeat(257) },
    ],
    [
      "a tool name with a space",
      { type: "tool.start", call, tool: "rm -rf /", kind: "shell" },
    ],
    [
      "a tool name over 128 characters",
      { type: "tool.start", call, tool: "a".repeat(129), kind: "shell" },
    ],
    [
      "an unknown kind",
      { type: "tool.start", call, tool: "Bash", kind: "network" },
    ],
    ["an unknown outcome", { type: "tool.end", call, outcome: "timeout" }],
    [
      "a call id with a space",
      { type: "tool.end", call: "a b", outcome: "ok" },
    ],
    [
      "a negative token count",
      {
        type: "usage",
        inputTokens: -1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    ],
    [
      "a fractional token count",
      {
        type: "usage",
        inputTokens: 1.5,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
    ],
    [
      "an error with a message",
      { type: "error", code: "vendor", message: "x" },
    ],
    ["an unknown error code", { type: "error", code: "oops" }],
    ["an unknown turn end reason", { type: "turn.end", reason: "timeout" }],
    ["an unknown event type", { type: "tool.input", call }],
  ];

  test.each(refused)("refuses %s", (_name, event) => {
    expect(streamEvent.safeParse(event).success).toBe(false);
  });

  test("a text delta of exactly 16 KiB is accepted", () => {
    expect(
      adapterEvent.safeParse({
        type: "text.delta",
        text: "a".repeat(16 * 1024),
      }).success,
    ).toBe(true);
  });

  test("permission events refuse a path, a command or a message", () => {
    const [request, decision] = runtimeEvents;
    expect(
      streamEvent.safeParse({ ...request, command: "rm -rf /" }).success,
    ).toBe(false);
    expect(
      streamEvent.safeParse({ ...request, paths: ["/etc/passwd"] }).success,
    ).toBe(false);
    expect(
      streamEvent.safeParse({ ...decision, reason: "/etc/passwd" }).success,
    ).toBe(false);
    expect(
      streamEvent.safeParse({ ...decision, reason: "x".repeat(65) }).success,
    ).toBe(false);
    expect(streamEvent.safeParse({ ...request, pathCount: 33 }).success).toBe(
      false,
    );
  });

  test("every text field of an event is an enum or matches a pattern, except the text of text.delta", () => {
    for (const option of streamEvent.options) {
      const schema = z.toJSONSchema(option, {
        io: "input",
        unrepresentable: "any",
      }) as {
        properties: Record<
          string,
          {
            type?: unknown;
            pattern?: string;
            enum?: unknown[];
            const?: unknown;
            anyOf?: unknown[];
          }
        >;
      };
      const type = option.shape.type.value;
      const open = Object.entries(schema.properties).filter(
        ([name, property]) =>
          property.type === "string" &&
          property.pattern === undefined &&
          property.enum === undefined &&
          property.const === undefined &&
          !(type === "text.delta" && name === "text"),
      );
      expect(open, type).toEqual([]);
    }
  });
});

describe("envelope", () => {
  test("accepts a turn event", () => {
    expect(
      adapterEnvelope.safeParse({
        seq: 1,
        turn: "t1",
        event: { type: "turn.end", reason: "completed" },
      }).success,
    ).toBe(true);
  });

  test.each([
    { type: "session", ref: "abc" },
    { type: "error", code: "cli-exited" },
  ])("accepts a null turn for $type", (event) => {
    expect(
      adapterEnvelope.safeParse({ seq: 3, turn: null, event }).success,
    ).toBe(true);
  });

  test("refuses a null turn for any other event", () => {
    expect(
      adapterEnvelope.safeParse({
        seq: 3,
        turn: null,
        event: { type: "text.delta", text: "x" },
      }).success,
    ).toBe(false);
  });

  test.each([0, -1, 1.5])("refuses seq %s", (seq) => {
    expect(
      adapterEnvelope.safeParse({
        seq,
        turn: "t1",
        event: { type: "turn.end", reason: "completed" },
      }).success,
    ).toBe(false);
  });
});

describe("ids", () => {
  test("a turn id is 1 to 64 letters, digits, _ or -", () => {
    expect(turnId.safeParse("a".repeat(64)).success).toBe(true);
    expect(turnId.safeParse("a_B-9").success).toBe(true);
    expect(turnId.safeParse("a".repeat(65)).success).toBe(false);
    expect(turnId.safeParse("").success).toBe(false);
    expect(turnId.safeParse("a.b").success).toBe(false);
  });

  test("a call id and a request id are 1 to 128 of letters, digits and _.:-", () => {
    for (const schema of [toolCallId, permissionRequestId]) {
      expect(schema.safeParse("a".repeat(128)).success).toBe(true);
      expect(schema.safeParse("a.b:c_d-e").success).toBe(true);
      expect(schema.safeParse("a".repeat(129)).success).toBe(false);
      expect(schema.safeParse("a/b").success).toBe(false);
    }
  });

  test("a session ref is printable ASCII", () => {
    expect(sessionRef.safeParse("session 1/ok").success).toBe(true);
    expect(sessionRef.safeParse("é").success).toBe(false);
  });
});

describe("permission request and decision", () => {
  const good = {
    request: "r1",
    call: null,
    tool: "Edit",
    kind: "file.write",
    paths: ["/work/a.txt"],
    command: null,
    truncated: false,
  };

  test("accepts a request with paths and a command", () => {
    expect(permissionRequest.safeParse(good).success).toBe(true);
    expect(
      permissionRequest.safeParse({ ...good, command: "ls -la" }).success,
    ).toBe(true);
  });

  test("refuses 33 paths, a path over 4096 bytes and a command over 4 KiB", () => {
    expect(
      permissionRequest.safeParse({ ...good, paths: Array(33).fill("/a") })
        .success,
    ).toBe(false);
    expect(
      permissionRequest.safeParse({ ...good, paths: ["a".repeat(4097)] })
        .success,
    ).toBe(false);
    expect(
      permissionRequest.safeParse({ ...good, command: "a".repeat(4097) })
        .success,
    ).toBe(false);
    expect(
      permissionRequest.safeParse({ ...good, paths: Array(32).fill("/a") })
        .success,
    ).toBe(true);
  });

  test("a decision has no scope field, so a grant covers one request", () => {
    const decision = { decision: "allow", by: "owner", reason: "ok" };
    expect(permissionDecision.safeParse(decision).success).toBe(true);
    expect(
      permissionDecision.safeParse({ ...decision, scope: "always" }).success,
    ).toBe(false);
    expect(
      permissionDecision.safeParse({ ...decision, by: "somebody" }).success,
    ).toBe(false);
  });

  test("denyAll denies by default", async () => {
    const answer = await denyAll(
      permissionRequest.parse(good),
      new AbortController().signal,
    );
    expect(answer).toEqual({
      decision: "deny",
      by: "default",
      reason: "no-rule",
    });
    expect(permissionDecision.safeParse(answer).success).toBe(true);
  });
});

describe("wire params", () => {
  test("initialize accepts a resume ref or null", () => {
    const params = {
      api: "0.1.0",
      bot: { id: "b1" },
      folder: "/work",
      resume: null,
    };
    expect(adapterInitializeParams.safeParse(params).success).toBe(true);
    expect(
      adapterInitializeParams.safeParse({ ...params, resume: "s1" }).success,
    ).toBe(true);
    expect(
      adapterInitializeParams.safeParse({ ...params, folder: "work" }).success,
    ).toBe(false);
    expect(
      adapterInitializeParams.safeParse({ ...params, extra: 1 }).success,
    ).toBe(false);
  });

  test("turn.start refuses a prompt over 256 KiB", () => {
    expect(
      turnStartParams.safeParse({ turn: "t1", text: "a".repeat(256 * 1024) })
        .success,
    ).toBe(true);
    expect(
      turnStartParams.safeParse({
        turn: "t1",
        text: "a".repeat(256 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(turnCancelParams.safeParse({ turn: "t 1" }).success).toBe(false);
  });
});
