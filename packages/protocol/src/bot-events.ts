import { z } from "zod";

const maxDeltaBytes = 16 * 1024;

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const deltaText = z.string().refine(
  (text) => {
    const size = utf8Length(text);
    return size >= 1 && size <= maxDeltaBytes;
  },
  { error: "must be 1 to 16384 bytes" },
);

const turnPattern = /^[A-Za-z0-9_-]{1,64}$/;
const callPattern = /^[A-Za-z0-9_.:-]{1,128}$/;

const toolKind = z
  .enum(["file.read", "file.write", "shell", "web", "other"])
  .describe("What the tool does, in terms that don't depend on the vendor.");

const count = z.int().nonnegative();

const turnId = z
  .string()
  .regex(turnPattern)
  .describe("The id of one turn, the bot's work on one prompt.");

const botName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/)
  .describe("The name of the bot, as in its config.");

const textDelta = z
  .strictObject({
    type: z.literal("text.delta").describe("The kind of event."),
    text: deltaText.describe(
      "The next piece of the bot's reply. It is 1 byte to 16 KiB of UTF-8.",
    ),
  })
  .meta({ id: "BotTextDelta", description: "A piece of the bot's reply." });

const toolStart = z
  .strictObject({
    type: z.literal("tool.start").describe("The kind of event."),
    call: z
      .string()
      .regex(callPattern)
      .describe("The id of the tool call, for the matching `tool.end`."),
    tool: z.string().regex(callPattern).describe("The tool's name."),
    kind: toolKind,
  })
  .meta({ id: "BotToolStart", description: "The bot started to use a tool." });

const toolEnd = z
  .strictObject({
    type: z.literal("tool.end").describe("The kind of event."),
    call: z
      .string()
      .regex(callPattern)
      .describe("The id of the tool call that ended."),
    outcome: z
      .enum(["ok", "error", "denied", "cancelled"])
      .describe("How the call ended."),
  })
  .meta({ id: "BotToolEnd", description: "A tool call ended." });

const usage = z
  .strictObject({
    type: z.literal("usage").describe("The kind of event."),
    inputTokens: count.describe("Tokens the bot read."),
    outputTokens: count.describe("Tokens the bot wrote."),
    cacheReadTokens: count.describe("Tokens read from the vendor's cache."),
    cacheWriteTokens: count.describe("Tokens written to the vendor's cache."),
    costUsd: z
      .number()
      .nonnegative()
      .nullable()
      .describe("The cost in US dollars, or `null` when the vendor has none."),
  })
  .meta({ id: "BotUsage", description: "What a turn used." });

const error = z
  .strictObject({
    type: z.literal("error").describe("The kind of event."),
    code: z
      .enum([
        "cli-not-found",
        "cli-exited",
        "signed-out",
        "rate-limited",
        "vendor",
        "adapter",
      ])
      .describe("What went wrong, as a fixed code."),
  })
  .meta({ id: "BotError", description: "Something went wrong with the bot." });

const turnEnd = z
  .strictObject({
    type: z.literal("turn.end").describe("The kind of event."),
    reason: z
      .enum(["completed", "cancelled", "denied", "limit", "refused", "error"])
      .describe("Why the turn ended."),
  })
  .meta({ id: "BotTurnEnd", description: "A turn ended." });

const permissionRequest = z
  .strictObject({
    type: z.literal("permission.request").describe("The kind of event."),
    request: z
      .string()
      .regex(callPattern)
      .describe("The id of the request, for the matching decision."),
    call: z
      .string()
      .regex(callPattern)
      .nullable()
      .describe("The tool call the request is for, or `null`."),
    tool: z.string().regex(callPattern).describe("The tool's name."),
    kind: toolKind,
    pathCount: z
      .int()
      .min(0)
      .max(32)
      .describe("How many paths the tool wants. The paths are never sent."),
    hasCommand: z
      .boolean()
      .describe("Whether the tool wants to run a command. It is never sent."),
  })
  .meta({
    id: "BotPermissionRequest",
    description: "The bot asked whether a tool may run.",
  });

const permissionDecision = z
  .strictObject({
    type: z.literal("permission.decision").describe("The kind of event."),
    request: z
      .string()
      .regex(callPattern)
      .describe("The id of the request this decision answers."),
    decision: z.enum(["allow", "deny"]).describe("The answer."),
    by: z.enum(["rule", "policy", "owner", "default"]).describe("Who decided."),
    reason: z
      .enum([
        "inside-folder",
        "outside-folder",
        "web",
        "shell",
        "unknown-tool",
        "cancelled",
        "turn-ended",
        "timeout",
        "shutdown",
        "no-decider",
        "invalid-request",
        "duplicate-request",
        "invalid-decision",
        "decider-failed",
      ])
      .describe("Why, as a fixed code."),
  })
  .meta({
    id: "BotPermissionDecision",
    description: "A permission request was allowed or denied.",
  });

export const botEvents = [
  textDelta,
  toolStart,
  toolEnd,
  usage,
  error,
  turnEnd,
  permissionRequest,
  permissionDecision,
] as const;

export const botEvent = z.discriminatedUnion("type", botEvents).meta({
  id: "BotEvent",
  description:
    "One thing a bot did. The bot's session is not one of them: the server keeps it.",
});
export type BotEvent = z.infer<typeof botEvent>;

export const botEventPayload = z
  .strictObject({
    bot: botName.describe("The bot the event belongs to."),
    turn: turnId
      .nullable()
      .describe(
        "The turn the event belongs to. It is `null` for an `error` outside a turn.",
      ),
    format: z
      .int()
      .min(1)
      .describe(
        "The format version of the saved event. It is 1 today, and a change to an event's shape raises it.",
      ),
    event: botEvent.describe("What happened."),
  })
  .describe("One event of one bot, in the order the server saved it.");
