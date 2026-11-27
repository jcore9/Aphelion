import type {
  HookCallback,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Decider } from "@aphelion/plugin-sdk";
import { z } from "zod";
import { permissionRequestFor } from "./tools.ts";

export const refusalMessage = "Aphelion denied this tool call.";

const blocked: SyncHookJSONOutput = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: refusalMessage,
  },
};

const passOn: SyncHookJSONOutput = {};

const toolInput = z.record(z.string(), z.unknown());

export function preToolUseHook(rule: Decider, folder: string): HookCallback {
  return async (input, _toolUseID, { signal }) => {
    try {
      if (input.hook_event_name !== "PreToolUse") return blocked;
      const fields = toolInput.safeParse(input.tool_input);
      if (!fields.success) return blocked;
      const request = permissionRequestFor({
        tool: input.tool_name,
        input: fields.data,
        call: input.tool_use_id,
        request: input.tool_use_id,
      });
      if (!request) return blocked;
      const answer = await rule(request, signal, { folder });
      return answer.decision === "allow" ? passOn : blocked;
    } catch {
      return blocked;
    }
  };
}

export interface Trust {
  readonly checked: Promise<boolean>;
  settle(trusted: boolean): void;
}

export function unchecked(): Trust {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  return { checked: promise, settle: resolve };
}

export function untilTrusted(trust: Trust, hook: HookCallback): HookCallback {
  return async (input, toolUseID, options) =>
    (await trust.checked) ? hook(input, toolUseID, options) : blocked;
}
