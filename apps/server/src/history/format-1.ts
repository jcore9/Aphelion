import { z } from "zod";

const utf8 = new TextEncoder();

const callId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .brand<"ToolCallId">();

const requestId = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,128}$/)
  .brand<"PermissionRequestId">();

const sessionRef = z
  .string()
  .regex(/^[\x21-\x2e\x30-\x7e]{1,256}$/)
  .brand<"SessionRef">();

const toolName = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const toolKind = z.enum(["file.read", "file.write", "shell", "web", "other"]);

const count = z.int().nonnegative();

export const formatOneEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session"), ref: sessionRef }),
  z.strictObject({
    type: z.literal("text.delta"),
    text: z.string().refine((text) => {
      const size = utf8.encode(text).byteLength;
      return size >= 1 && size <= 16 * 1024;
    }),
  }),
  z.strictObject({
    type: z.literal("tool.start"),
    call: callId,
    tool: toolName,
    kind: toolKind,
  }),
  z.strictObject({
    type: z.literal("tool.end"),
    call: callId,
    outcome: z.enum(["ok", "error", "denied", "cancelled"]),
  }),
  z.strictObject({
    type: z.literal("usage"),
    inputTokens: count,
    outputTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum([
      "cli-not-found",
      "cli-exited",
      "signed-out",
      "rate-limited",
      "vendor",
      "adapter",
    ]),
  }),
  z.strictObject({
    type: z.literal("turn.end"),
    reason: z.enum([
      "completed",
      "cancelled",
      "denied",
      "limit",
      "refused",
      "error",
    ]),
  }),
  z.strictObject({
    type: z.literal("permission.request"),
    request: requestId,
    call: callId.nullable(),
    tool: toolName,
    kind: toolKind,
    pathCount: z.int().min(0).max(32),
    hasCommand: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("permission.decision"),
    request: requestId,
    decision: z.enum(["allow", "deny"]),
    by: z.enum(["rule", "policy", "owner", "default"]),
    reason: z.enum([
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
    ]),
  }),
]);

export type FormatOneEvent = z.infer<typeof formatOneEvent>;
