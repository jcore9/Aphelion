import type { AdapterEvent } from "@aphelion/plugin-sdk";
import { z } from "zod";

type ErrorCode = Extract<AdapterEvent, { type: "error" }>["code"];
type TurnEndReason = Extract<AdapterEvent, { type: "turn.end" }>["reason"];
type Usage = Extract<AdapterEvent, { type: "usage" }>;

const mainThread = { parent_tool_use_id: z.null() };

const initMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  permissionMode: z.string(),
  claude_code_version: z.string(),
});

const textDelta = z.object({
  type: z.literal("stream_event"),
  ...mainThread,
  event: z.object({
    type: z.literal("content_block_delta"),
    delta: z.object({ type: z.literal("text_delta"), text: z.string() }),
  }),
});

const toolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
});

const assistantMessage = z.object({
  type: z.literal("assistant"),
  ...mainThread,
  error: z.string().optional(),
  message: z.object({ content: z.array(z.unknown()) }),
});

const toolResult = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});

const userMessage = z.object({
  type: z.literal("user"),
  ...mainThread,
  isReplay: z.literal(true).optional(),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const tokens = z.int().nonnegative();

const resultMessage = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  stop_reason: z.string().nullable(),
  terminal_reason: z.string().optional(),
  api_error_status: z.number().nullish(),
  total_cost_usd: z.number().nonnegative(),
  usage: z.object({
    input_tokens: tokens,
    output_tokens: tokens,
    cache_read_input_tokens: tokens.nullish(),
    cache_creation_input_tokens: tokens.nullish(),
  }),
});

const rejectedRateLimit = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({ status: z.literal("rejected") }),
});

const authFailure = z.object({
  type: z.literal("auth_status"),
  error: z.string(),
});

const typed = z.object({ type: z.string() });

export interface ToolCall {
  readonly id: string;
  readonly name: string;
}

export interface ToolResult {
  readonly id: string;
  readonly isError: boolean;
}

export interface TurnResult {
  readonly subtype: string;
  readonly isError: boolean;
  readonly stopReason: string | null;
  readonly terminalReason: string | null;
  readonly apiStatus: number | null;
  readonly totalCostUsd: number;
  readonly usage: Omit<Usage, "type" | "costUsd">;
}

export type ClaudeMessage =
  | {
      readonly kind: "init";
      readonly session: string;
      readonly permissionMode: string;
      readonly version: string;
    }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly calls: readonly ToolCall[];
      readonly error: ErrorCode | null;
    }
  | { readonly kind: "tool-results"; readonly results: readonly ToolResult[] }
  | { readonly kind: "result"; readonly result: TurnResult | null }
  | { readonly kind: "error"; readonly code: ErrorCode }
  | { readonly kind: "other" };

const signedOutErrors = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
]);

const rateLimitErrors = new Set(["rate_limit", "billing_error"]);

const assistantErrorCode = (error: string): ErrorCode => {
  if (signedOutErrors.has(error)) return "signed-out";
  if (rateLimitErrors.has(error)) return "rate-limited";
  return "vendor";
};

const blocks = <T>(content: readonly unknown[], schema: z.ZodType<T>) =>
  content.flatMap((block) => {
    const parsed = schema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });

const other = { kind: "other" } as const;

export function parseMessage(raw: unknown): ClaudeMessage {
  const type = typed.safeParse(raw);
  if (!type.success) return other;
  switch (type.data.type) {
    case "system": {
      const init = initMessage.safeParse(raw);
      return init.success
        ? {
            kind: "init",
            session: init.data.session_id,
            permissionMode: init.data.permissionMode,
            version: init.data.claude_code_version,
          }
        : other;
    }
    case "stream_event": {
      const delta = textDelta.safeParse(raw);
      return delta.success
        ? { kind: "text", text: delta.data.event.delta.text }
        : other;
    }
    case "assistant": {
      const message = assistantMessage.safeParse(raw);
      if (!message.success) return other;
      return {
        kind: "assistant",
        calls: blocks(message.data.message.content, toolUse),
        error:
          message.data.error === undefined
            ? null
            : assistantErrorCode(message.data.error),
      };
    }
    case "user": {
      const message = userMessage.safeParse(raw);
      if (!message.success || message.data.isReplay) return other;
      const { content } = message.data.message;
      if (typeof content === "string") return other;
      return {
        kind: "tool-results",
        results: blocks(content, toolResult).map((block) => ({
          id: block.tool_use_id,
          isError: block.is_error ?? false,
        })),
      };
    }
    case "result": {
      const result = resultMessage.safeParse(raw);
      if (!result.success) return { kind: "result", result: null };
      const { data } = result;
      return {
        kind: "result",
        result: {
          subtype: data.subtype,
          isError: data.is_error,
          stopReason: data.stop_reason,
          terminalReason: data.terminal_reason ?? null,
          apiStatus: data.api_error_status ?? null,
          totalCostUsd: data.total_cost_usd,
          usage: {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: data.usage.cache_creation_input_tokens ?? 0,
          },
        },
      };
    }
    case "rate_limit_event":
      return rejectedRateLimit.safeParse(raw).success
        ? { kind: "error", code: "rate-limited" }
        : other;
    case "auth_status":
      return authFailure.safeParse(raw).success
        ? { kind: "error", code: "signed-out" }
        : other;
    default:
      return other;
  }
}

const abortReasons = new Set(["aborted_streaming", "aborted_tools"]);

const limitSubtypes = new Set(["error_max_turns", "error_max_budget_usd"]);

const limitReasons = new Set([
  "max_turns",
  "budget_exhausted",
  "blocking_limit",
  "prompt_too_long",
]);

const statusCode = (status: number | null): ErrorCode => {
  if (status === 401) return "signed-out";
  if (status === 429) return "rate-limited";
  return "vendor";
};

export type ResultOutcome =
  | { readonly reason: Exclude<TurnEndReason, "error"> }
  | { readonly reason: "error"; readonly code: ErrorCode };

export function resultOutcome(
  result: TurnResult | null,
  cancelling: boolean,
): ResultOutcome {
  if (result === null) return { reason: "error", code: "vendor" };
  const terminal = result.terminalReason ?? "";
  if (cancelling && abortReasons.has(terminal)) return { reason: "cancelled" };
  if (limitSubtypes.has(result.subtype) || limitReasons.has(terminal)) {
    return { reason: "limit" };
  }
  if (result.subtype === "success" && !result.isError) {
    return {
      reason: result.stopReason === "refusal" ? "refused" : "completed",
    };
  }
  return { reason: "error", code: statusCode(result.apiStatus) };
}
