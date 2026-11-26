import type {
  Options,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, QueryFunction } from "./adapter.ts";

export type ScriptStep =
  | { readonly send: unknown }
  | {
      readonly ask: {
        readonly tool: string;
        readonly input: Record<string, unknown>;
        readonly toolUseID: string;
        readonly requestId: string;
      };
    }
  | { readonly hang: true }
  | { readonly exit: true }
  | { readonly throws: unknown };

export interface QueryRun {
  readonly options: Options;
  readonly prompts: SDKUserMessage[];
}

export interface ScriptedQuery {
  readonly query: QueryFunction;
  readonly runs: readonly QueryRun[];
  readonly answers: readonly (PermissionResult | null)[];
}

export const abortedError = () =>
  Object.assign(new Error("Claude Code process aborted by user"), {
    errorClass: "aborted",
  });

const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    const fail = () => {
      reject(abortedError());
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });

export function scriptedQuery(
  turns: readonly (readonly ScriptStep[])[],
): ScriptedQuery {
  const runs: QueryRun[] = [];
  const answers: (PermissionResult | null)[] = [];
  let nextTurn = 0;

  const query: QueryFunction = ({ prompt, options }) => {
    const run: QueryRun = { options, prompts: [] };
    runs.push(run);
    const signal =
      options.abortController?.signal ?? new AbortController().signal;
    const aborted = untilAborted(signal);
    aborted.catch(() => undefined);

    async function* messages(): AsyncGenerator {
      const input = prompt[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([input.next(), aborted]);
        if (next.done) return;
        run.prompts.push(next.value);
        for (const step of turns[nextTurn++] ?? []) {
          if ("send" in step) {
            if (signal.aborted) throw abortedError();
            yield step.send;
          } else if ("ask" in step) {
            const { tool, input: toolInput, toolUseID, requestId } = step.ask;
            if (!options.canUseTool) throw new Error("no canUseTool");
            answers.push(
              await options.canUseTool(tool, toolInput, {
                signal,
                toolUseID,
                requestId,
              }),
            );
          } else if ("hang" in step) {
            await aborted;
          } else if ("exit" in step) {
            return;
          } else {
            throw step.throws;
          }
        }
      }
    }

    const iterator = messages();
    const handle: ClaudeQuery = {
      [Symbol.asyncIterator]: () => iterator,
    };
    return handle;
  };

  return { query, runs, answers };
}

const sessionId = "4f1e2d3c-0000-4000-8000-000000000001";

export const sdk = {
  sessionId,
  init: (
    overrides: Partial<{
      session_id: string;
      permissionMode: string;
      claude_code_version: string;
    }> = {},
  ) => ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    permissionMode: "default",
    claude_code_version: "2.1.330",
    apiKeySource: "none",
    cwd: "/work",
    tools: ["Read", "Bash"],
    ...overrides,
  }),
  text: (text: string, parent: string | null = null) => ({
    type: "stream_event",
    parent_tool_use_id: parent,
    session_id: sessionId,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  }),
  toolUse: (id: string, name: string, input: Record<string, unknown> = {}) => ({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
    },
  }),
  assistantError: (error: string) => ({
    type: "assistant",
    parent_tool_use_id: null,
    session_id: sessionId,
    error,
    message: { role: "assistant", content: [] },
  }),
  toolResult: (id: string, isError = false) => ({
    type: "user",
    parent_tool_use_id: null,
    session_id: sessionId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          is_error: isError,
          content: "",
        },
      ],
    },
  }),
  result: (
    overrides: Partial<{
      subtype: string;
      is_error: boolean;
      stop_reason: string | null;
      terminal_reason: string;
      api_error_status: number | null;
      total_cost_usd: number;
      result: string;
      errors: string[];
    }> = {},
  ) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    session_id: sessionId,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
    },
    ...overrides,
  }),
};
