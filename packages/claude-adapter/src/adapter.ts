import type {
  CanUseTool,
  Options,
  PermissionResult,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  adapterEvent,
  sessionRef,
  type AdapterContext,
  type AdapterEvent,
  type AdapterSession,
  type BotAdapter,
  type Decider,
  type SessionRef,
  type ToolCallId,
  type TurnInput,
} from "@aphelion/plugin-sdk";
import { z } from "zod";
import { channel, drain, type Channel } from "./channel.ts";
import {
  preToolUseHook,
  refusalMessage,
  unchecked,
  untilTrusted,
  type Trust,
  type TurnTrust,
} from "./hook.ts";
import {
  parseMessage,
  resultOutcome,
  type ClaudeMessage,
  type Plugin,
  type ToolCall,
} from "./messages.ts";
import {
  claudeCodeVersion,
  claudeEnv,
  givenTools,
  queryOptions,
  type ParentEnv,
} from "./options.ts";
import { splitBytes } from "./text.ts";
import {
  after,
  settlesWithin,
  unlessAborted,
  whenAborted,
  type Wait,
} from "./timing.ts";
import { permissionRequestFor, toolKind } from "./tools.ts";

export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
}

export type QueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeQuery;

export interface ClaudeAdapterOptions {
  readonly query: QueryFunction;
  readonly env: ParentEnv;
  readonly rule: Decider;
  readonly interruptWaitMs?: number;
  readonly closeWaitMs?: number;
}

type ErrorCode = Extract<AdapterEvent, { type: "error" }>["code"];
type TurnEndReason = Extract<AdapterEvent, { type: "turn.end" }>["reason"];

type Item =
  | { readonly kind: "message"; readonly message: ClaudeMessage }
  | { readonly kind: "refused" }
  | { readonly kind: "ended" }
  | { readonly kind: "failed"; readonly error: unknown };

interface Live {
  readonly query: ClaudeQuery;
  readonly prompts: Channel<SDKUserMessage>;
  readonly abort: AbortController;
  readonly trust: Trust;
  readonly done: Promise<void>;
}

interface ActiveTurn {
  readonly input: TurnInput;
  readonly signal: AbortSignal;
  readonly live: Live;
  readonly trust: TurnTrust;
  readonly inbox: Channel<Item>;
  readonly denied: Set<string>;
  errorSent: boolean;
}

interface Call {
  readonly id: ToolCallId;
  ended: boolean;
}

const claudeSessionId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const claudeRef = (value: string): SessionRef | undefined => {
  const parsed = sessionRef.safeParse(value);
  return parsed.success && claudeSessionId.test(value)
    ? parsed.data
    : undefined;
};

const refusal: PermissionResult = {
  behavior: "deny",
  message: refusalMessage,
};

const failureClasses = [
  "aborted",
  "control_request_failed",
  "error_result",
  "executable_launch_failed",
  "executable_not_found",
  "initialize_timeout",
  "process_exited_nonzero",
  "process_killed_by_signal",
  "unreadable",
] as const;

const sdkFailure = z.object({ errorClass: z.enum(failureClasses) });

const notFoundClasses = new Set<string>([
  "executable_not_found",
  "executable_launch_failed",
]);

const failureClass = (error: unknown) => {
  const parsed = sdkFailure.safeParse(error);
  return parsed.success ? parsed.data.errorClass : "unknown";
};

const maxDeltaBytes = 16 * 1024;

const prompt = (text: string): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: text },
  parent_tool_use_id: null,
});

const turnEnd = (reason: TurnEndReason): AdapterEvent => ({
  type: "turn.end",
  reason,
});

const lineCount = (data: string) =>
  data.split("\n").filter((line) => line !== "").length;

const builtIn = (plugin: Plugin) =>
  plugin.path === "builtin" && plugin.name.startsWith("cc-plugin-");

const unexpected = `the CLI didn't start as Claude Code ${claudeCodeVersion} in default permission mode`;

const initProblem = (message: ClaudeMessage): string | undefined => {
  if (message.kind === "unreadable-init") return unexpected;
  if (message.kind !== "init") return undefined;
  if (
    message.permissionMode !== "default" ||
    message.version !== claudeCodeVersion
  ) {
    return unexpected;
  }
  const tools = message.tools.filter((tool) => !givenTools.has(tool)).length;
  const plugins = message.plugins.filter((plugin) => !builtIn(plugin)).length;
  if (tools === 0 && message.mcpServers === 0 && plugins === 0) {
    return undefined;
  }
  return `the session reported ${String(tools)} tools, ${String(message.mcpServers)} MCP servers and ${String(plugins)} plugins that Aphelion didn't give it`;
};

export function claudeAdapter(options: ClaudeAdapterOptions): BotAdapter {
  const interruptWaitMs = options.interruptWaitMs ?? 3000;
  const closeWaitMs = options.closeWaitMs ?? 5000;
  const env = claudeEnv(options.env);

  return {
    provider: "claude",
    open(context: AdapterContext): AdapterSession {
      const calls = new Map<string, Call>();
      let saved =
        context.resume === null ? null : (claudeRef(context.resume) ?? null);
      let announced: SessionRef | null = null;
      let costBaseline: number | null = null;
      let live: Live | undefined;
      let active: ActiveTurn | undefined;
      let closed = false;

      if (context.resume !== null && saved === null) {
        context.log(
          "the saved session ref isn't a Claude session id, so the bot starts a new session",
        );
      }

      const preToolUse = preToolUseHook(options.rule, context.folder);

      const deliver = (owner: Live, item: Item) => {
        if (active?.live === owner) active.inbox.push(item);
      };

      const canUseTool =
        (abort: AbortController): CanUseTool =>
        async (tool, input, { signal, toolUseID, requestId, mcpServer }) => {
          try {
            const turn = active;
            if (turn?.live.abort !== abort) return refusal;
            if (!givenTools.has(tool) || mcpServer !== undefined) {
              return refusal;
            }
            const { trust } = turn;
            if (!(await trust.until(signal)) || active !== turn) {
              return refusal;
            }
            const request = permissionRequestFor({
              tool,
              input,
              call: toolUseID,
              request: requestId,
            });
            if (!request) return refusal;
            const decision = await unlessAborted(
              turn.input.decide(request),
              signal,
            );
            if (!trust.held || active !== turn) return refusal;
            if (decision?.decision === "allow") return { behavior: "allow" };
            if (decision?.announced) {
              turn.denied.add(toolUseID);
            }
            return refusal;
          } catch {
            return refusal;
          }
        };

      const admit = (owner: Live, message: ClaudeMessage) => {
        const problem = initProblem(message);
        if (problem !== undefined) {
          context.log(`${problem}, so the adapter stopped it`);
          kill(owner);
          deliver(owner, { kind: "refused" });
          return false;
        }
        if (message.kind === "init") {
          if (message.skills > 0) {
            context.log(
              `the session reported ${String(message.skills)} skills`,
            );
          }
          if (active?.live === owner) active.trust.grant();
        }
        return true;
      };

      const pump = async (owner: Live, stderrLines: () => number) => {
        let last: Item;
        try {
          for await (const raw of owner.query) {
            const message = parseMessage(raw);
            if (!admit(owner, message)) break;
            deliver(owner, { kind: "message", message });
          }
          last = { kind: "ended" };
        } catch (error) {
          last = { kind: "failed", error };
          if (!owner.abort.signal.aborted) {
            context.log(`the Claude CLI stopped: ${failureClass(error)}`);
          }
        }
        const lines = stderrLines();
        if (lines > 0) {
          context.log(`the CLI wrote ${String(lines)} lines to stderr`);
        }
        owner.trust.revoke();
        if (live === owner) live = undefined;
        deliver(owner, last);
      };

      const start = (): Live | undefined => {
        const abort = new AbortController();
        const prompts = channel<SDKUserMessage>();
        const trust: Trust = unchecked();
        let stderrLines = 0;
        if (saved === null) costBaseline = 0;
        try {
          const query = options.query({
            prompt: drain(prompts),
            options: queryOptions({
              folder: context.folder,
              resume: saved,
              env,
              canUseTool: canUseTool(abort),
              preToolUse: untilTrusted(trust, preToolUse),
              stderr: (data) => {
                stderrLines += lineCount(data);
              },
              abortController: abort,
            }),
          });
          const owner: Live = {
            query,
            prompts,
            abort,
            trust,
            done: Promise.resolve().then(() => pump(owner, () => stderrLines)),
          };
          live = owner;
          return owner;
        } catch (error) {
          context.log(`the Claude CLI didn't start: ${failureClass(error)}`);
          return undefined;
        }
      };

      const kill = (owner: Live) => {
        owner.trust.revoke();
        owner.abort.abort();
        if (live === owner) live = undefined;
      };

      const startCall = (call: ToolCall): AdapterEvent | undefined => {
        if (calls.has(call.id)) return undefined;
        const event = adapterEvent.safeParse({
          type: "tool.start",
          call: call.id,
          tool: call.name,
          kind: toolKind(call.name),
        });
        if (!event.success || event.data.type !== "tool.start")
          return undefined;
        calls.set(call.id, { id: event.data.call, ended: false });
        return event.data;
      };

      function* error(
        turn: ActiveTurn,
        code: ErrorCode,
      ): Generator<AdapterEvent> {
        if (turn.errorSent) return;
        turn.errorSent = true;
        yield { type: "error", code };
      }

      function* translate(
        turn: ActiveTurn,
        message: ClaudeMessage,
        cancelling: boolean,
      ): Generator<AdapterEvent, boolean> {
        switch (message.kind) {
          case "init": {
            const ref = claudeRef(message.session);
            if (ref && ref !== announced) {
              announced = ref;
              saved = ref;
              yield { type: "session", ref };
            }
            return false;
          }
          case "text":
            for (const text of splitBytes(message.text, maxDeltaBytes)) {
              yield { type: "text.delta", text };
            }
            return false;
          case "assistant":
            if (message.error) yield* error(turn, message.error);
            for (const call of message.calls) {
              const started = startCall(call);
              if (started) yield started;
            }
            return false;
          case "tool-results":
            for (const result of message.results) {
              const call = calls.get(result.id);
              if (!call || call.ended) continue;
              call.ended = true;
              yield {
                type: "tool.end",
                call: call.id,
                outcome: turn.denied.has(result.id)
                  ? "denied"
                  : result.isError
                    ? "error"
                    : "ok",
              };
            }
            return false;
          case "result": {
            const { result } = message;
            const outcome = resultOutcome(result, cancelling);
            const costUsd =
              result === null || costBaseline === null
                ? null
                : Math.max(0, result.totalCostUsd - costBaseline);
            if (result) costBaseline = result.totalCostUsd;
            if (outcome.reason === "error") {
              yield* error(turn, outcome.code);
            } else if (result && outcome.reason !== "cancelled") {
              yield { type: "usage", ...result.usage, costUsd };
            }
            yield turnEnd(outcome.reason);
            return true;
          }
          case "error":
            yield* error(turn, message.code);
            return false;
          case "unreadable-init":
          case "other":
            return false;
        }
      }

      async function* runTurn(
        input: TurnInput,
        signal: AbortSignal,
      ): AsyncGenerator<AdapterEvent> {
        if (closed || signal.aborted) {
          yield turnEnd("cancelled");
          return;
        }
        const owner = live ?? start();
        if (!owner) {
          yield { type: "error", code: "cli-exited" };
          yield turnEnd("error");
          return;
        }
        const turn: ActiveTurn = {
          input,
          signal,
          live: owner,
          trust: owner.trust.begin(),
          inbox: channel(),
          denied: new Set(),
          errorSent: false,
        };
        active = turn;
        const cancel = whenAborted(signal, "cancel" as const);
        let deadline: Wait<"deadline"> | undefined;

        try {
          owner.prompts.push(prompt(input.text));
          for (;;) {
            const woke = await Promise.race([
              turn.inbox.ready().then(() => "item" as const),
              deadline ? deadline.done : cancel.done,
            ]);
            if (woke === "cancel") {
              deadline = after(interruptWaitMs, "deadline" as const);
              void Promise.resolve()
                .then(() => owner.query.interrupt())
                .catch(() => undefined);
              continue;
            }
            if (woke === "deadline") {
              kill(owner);
              yield turnEnd("cancelled");
              return;
            }
            const item = turn.inbox.take();
            if (item === undefined) continue;
            if (item.kind === "message") {
              if (
                yield* translate(turn, item.message, deadline !== undefined)
              ) {
                return;
              }
              continue;
            }
            if (item.kind === "refused") {
              yield* error(turn, "vendor");
              yield turnEnd("error");
              return;
            }
            if (deadline) {
              yield turnEnd("cancelled");
            } else {
              yield* error(
                turn,
                item.kind === "failed" &&
                  notFoundClasses.has(failureClass(item.error))
                  ? "cli-not-found"
                  : "cli-exited",
              );
              yield turnEnd("error");
            }
            return;
          }
        } finally {
          cancel.stop();
          deadline?.stop();
          turn.trust.end();
          if (active === turn) active = undefined;
        }
      }

      const close = async () => {
        closed = true;
        const owner = live;
        live = undefined;
        if (!owner) return;
        owner.trust.revoke();
        owner.prompts.end();
        if (!(await settlesWithin(owner.done, closeWaitMs))) {
          owner.abort.abort();
        }
      };

      start();
      return { turn: runTurn, close };
    },
  };
}
