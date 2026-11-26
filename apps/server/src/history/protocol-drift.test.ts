import { streamEvent } from "@aphelion/plugin-sdk";
import { botEvent } from "@aphelion/protocol";
import { describe, expect, test } from "vitest";
import { z } from "zod";

const samples = [
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

const sdkOptions = (streamEvent.options as readonly z.ZodType[]).filter(
  (option) => kindOf(option) !== "session",
);
const protocolOptions = botEvent.options as readonly z.ZodType[];

describe("the protocol's bot events and the adapter's stream events", () => {
  test("have the same kinds, except that the protocol has no session", () => {
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

  test("keep the vendor's session out of the protocol", () => {
    const session = { type: "session", ref: "s-1" };

    expect(streamEvent.safeParse(session).success).toBe(true);
    expect(botEvent.safeParse(session).success).toBe(false);
  });
});

const sample = (type: string) => {
  const found = samples.find((candidate) => candidate.type === type);
  if (found === undefined) throw new Error(`no sample for ${type}`);
  return found;
};

const withField = (type: string, field: string, value: unknown) => ({
  ...sample(type),
  [field]: value,
});

const text = (type: string, value: string) => ({
  ...sample(type),
  text: value,
});

const ids = (type: string, field: string): [string, unknown, boolean][] => [
  [`${type} ${field} of 1 character`, withField(type, field, "a"), true],
  [
    `${type} ${field} of 128 characters`,
    withField(type, field, "a".repeat(128)),
    true,
  ],
  [
    `${type} ${field} of 129 characters`,
    withField(type, field, "a".repeat(129)),
    false,
  ],
  [`${type} ${field} that is empty`, withField(type, field, ""), false],
  [`${type} ${field} with a space`, withField(type, field, "a b"), false],
  [`${type} ${field} with a newline`, withField(type, field, "a\n"), false],
  [`${type} ${field} that isn't text`, withField(type, field, 1), false],
];

const enums = (
  type: string,
  field: string,
  good: readonly string[],
): [string, unknown, boolean][] => [
  ...good.map((value): [string, unknown, boolean] => [
    `${type} ${field} ${value}`,
    withField(type, field, value),
    true,
  ]),
  [`${type} ${field} unknown`, withField(type, field, "tired"), false],
];

const counts = (field: string): [string, unknown, boolean][] => [
  [`usage ${field} of 0`, withField("usage", field, 0), true],
  [
    `usage ${field} of the largest safe integer`,
    withField("usage", field, Number.MAX_SAFE_INTEGER),
    true,
  ],
  [`usage ${field} below 0`, withField("usage", field, -1), false],
  [`usage ${field} with a fraction`, withField("usage", field, 1.5), false],
  [
    `usage ${field} above the safe integers`,
    withField("usage", field, Number.MAX_SAFE_INTEGER + 2),
    false,
  ],
];

const limit = 16 * 1024;
const deltas: [string, string, boolean][] = [
  ["empty", "", false],
  ["1 byte", "a", true],
  ["16384 ASCII bytes", "a".repeat(limit), true],
  ["16385 ASCII bytes", "a".repeat(limit + 1), false],
  ["16384 bytes in 8192 two-byte characters", "é".repeat(limit / 2), true],
  ["16386 bytes in 8193 two-byte characters", "é".repeat(limit / 2 + 1), false],
  ["32768 bytes in 16384 two-byte characters", "é".repeat(limit), false],
  ["16384 bytes in three-byte characters", `${"€".repeat(5461)}a`, true],
  ["16386 bytes in 5462 three-byte characters", "€".repeat(5462), false],
  ["16384 bytes in 4096 four-byte characters", "😀".repeat(limit / 4), true],
  [
    "16388 bytes in 4097 four-byte characters",
    "😀".repeat(limit / 4 + 1),
    false,
  ],
  ["16384 bytes with lone surrogates", `${"\ud800".repeat(5461)}a`, true],
  ["16386 bytes with lone surrogates", "\ud800".repeat(5462), false],
];

const acceptance: [string, unknown, boolean][] = [
  ...deltas.map(([name, value, accepted]): [string, unknown, boolean] => [
    `a text delta of ${name}`,
    text("text.delta", value),
    accepted,
  ]),
  ["a text delta that isn't text", text("text.delta", 1 as never), false],
  ...ids("tool.start", "call"),
  ...ids("tool.start", "tool"),
  ...ids("tool.end", "call"),
  ...ids("permission.request", "tool"),
  ...ids("permission.request", "request"),
  ...ids("permission.decision", "request"),
  [
    "permission.request call of 129 characters",
    withField("permission.request", "call", "a".repeat(129)),
    false,
  ],
  [
    "permission.request call of null",
    withField("permission.request", "call", null),
    true,
  ],
  ...enums("tool.start", "kind", [
    "file.read",
    "file.write",
    "shell",
    "web",
    "other",
  ]),
  ...enums("permission.request", "kind", ["shell"]),
  ...enums("tool.end", "outcome", ["ok", "error", "denied", "cancelled"]),
  ...enums("error", "code", [
    "cli-not-found",
    "cli-exited",
    "signed-out",
    "rate-limited",
    "vendor",
    "adapter",
  ]),
  ...enums("turn.end", "reason", [
    "completed",
    "cancelled",
    "denied",
    "limit",
    "refused",
    "error",
  ]),
  ...enums("permission.decision", "decision", ["allow", "deny"]),
  ...enums("permission.decision", "by", ["rule", "policy", "owner", "default"]),
  ...enums("permission.decision", "reason", [
    "inside-folder",
    "decider-failed",
  ]),
  ...counts("inputTokens"),
  ...counts("outputTokens"),
  ...counts("cacheReadTokens"),
  ...counts("cacheWriteTokens"),
  ["usage costUsd of 0", withField("usage", "costUsd", 0), true],
  ["usage costUsd of null", withField("usage", "costUsd", null), true],
  ["usage costUsd below 0", withField("usage", "costUsd", -0.01), false],
  ["usage costUsd of NaN", withField("usage", "costUsd", Number.NaN), false],
  [
    "usage costUsd of infinity",
    withField("usage", "costUsd", Number.POSITIVE_INFINITY),
    false,
  ],
  [
    "permission.request pathCount of 0",
    withField("permission.request", "pathCount", 0),
    true,
  ],
  [
    "permission.request pathCount of 32",
    withField("permission.request", "pathCount", 32),
    true,
  ],
  [
    "permission.request pathCount of 33",
    withField("permission.request", "pathCount", 33),
    false,
  ],
  [
    "permission.request pathCount below 0",
    withField("permission.request", "pathCount", -1),
    false,
  ],
  [
    "permission.request pathCount with a fraction",
    withField("permission.request", "pathCount", 1.5),
    false,
  ],
  [
    "permission.request hasCommand that isn't a boolean",
    withField("permission.request", "hasCommand", 1),
    false,
  ],
  [
    "an event with a field it doesn't define",
    withField("turn.end", "extra", 1),
    false,
  ],
  ["an event with no type", { reason: "completed" }, false],
  ["an unknown event type", { type: "thinking" }, false],
];

describe("the protocol and the adapter accept and refuse the same events", () => {
  test.each(acceptance)("%s", (_, event, accepted) => {
    expect(streamEvent.safeParse(event).success).toBe(accepted);
    expect(botEvent.safeParse(event).success).toBe(accepted);
  });

  test("have a case at, below and above the limit of every kind", () => {
    expect(
      new Set(acceptance.map(([, event]) => (event as { type?: string }).type)),
    ).toEqual(
      new Set(sdkOptions.map(kindOf)).union(new Set(["thinking", undefined])),
    );
  });
});
