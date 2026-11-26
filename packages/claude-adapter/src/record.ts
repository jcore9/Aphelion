import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQuery, QueryFunction } from "./adapter.ts";

export function recordingQuery(
  base: QueryFunction,
  record: (message: unknown) => void,
): QueryFunction {
  return (params) => {
    const inner = base(params);
    async function* messages() {
      for await (const message of inner) {
        record(message);
        yield message;
      }
    }
    const recorded: ClaudeQuery = {
      [Symbol.asyncIterator]: messages,
      interrupt: () => inner.interrupt(),
    };
    return recorded;
  };
}

export const recordingClaude = (record: (message: unknown) => void) =>
  recordingQuery(query, record);
