import type {
  HookCallback,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { Decider } from "@aphelion/plugin-sdk";
import { z } from "zod";
import { givenTools } from "./options.ts";
import { unlessAborted } from "./timing.ts";
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
      if (!givenTools.has(input.tool_name) || input.mcp_server !== undefined) {
        return blocked;
      }
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
  readonly revoked: boolean;
  reset(): void;
  grant(): void;
  revoke(): void;
  until(signal: AbortSignal): Promise<boolean>;
}

export function unchecked(): Trust {
  let revoked = false;
  let granted = false;
  let check = Promise.withResolvers<boolean>();
  return {
    get revoked() {
      return revoked;
    },
    reset() {
      if (!granted || revoked) return;
      granted = false;
      check = Promise.withResolvers<boolean>();
    },
    grant() {
      if (revoked) return;
      granted = true;
      check.resolve(true);
    },
    revoke() {
      revoked = true;
      check.resolve(false);
    },
    async until(signal) {
      if (revoked) return false;
      const trusted = await unlessAborted(check.promise, signal);
      return trusted === true && !revoked;
    },
  };
}

export function untilTrusted(trust: Trust, hook: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    if (!(await trust.until(options.signal))) return blocked;
    const answer = await hook(input, toolUseID, options);
    return trust.revoked ? blocked : answer;
  };
}
