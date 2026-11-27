import {
  denyAll,
  permissionRequestId,
  toolCallId,
  turnId,
  type AdapterEvent,
  type Decider,
  type PermissionRequest,
} from "@aphelion/plugin-sdk";
import {
  checkStream,
  runTurn,
  startAdapter,
  type AdapterHarness,
} from "@aphelion/plugin-sdk/testing";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapter.ts";
import {
  abortedError,
  scriptedQuery,
  sdk,
  type ScriptStep,
} from "./scripted-query.ts";
import { settlesWithin, whenAborted } from "./timing.ts";

const fakeKey = "sk-ant-api03-fake-0123456789abcdefghijklmnopqrstuvwxyz";

const setup = (
  turns: readonly (readonly ScriptStep[])[],
  env: Record<string, string> = { HOME: "/var/lib/aphelion-bots" },
) => {
  const scripted = scriptedQuery(turns);
  const adapter = claudeAdapter({
    query: scripted.query,
    env,
    rule: denyAll,
    interruptWaitMs: 50,
    closeWaitMs: 100,
  });
  return { scripted, adapter };
};

const eventsOf = (run: {
  readonly events: readonly { readonly event: unknown }[];
}) => run.events.map(({ event }) => event);

const allow: Decider = () => ({
  decision: "allow",
  by: "rule",
  reason: "inside-folder",
});

const untilTurnEnd = (harness: AdapterHarness, turn: string) =>
  harness.untilEvent(
    (envelope) => envelope.turn === turn && envelope.event.type === "turn.end",
  );

const completed: ScriptStep[] = [
  { send: sdk.init() },
  { send: sdk.text("Hello") },
  { send: sdk.text(", world") },
  { send: sdk.result() },
];

describe("a turn with text only", () => {
  it("names the session, streams the text, then reports usage and the end", async () => {
    const { adapter, scripted } = setup([completed]);
    const run = await runTurn(adapter, { text: "say hello" });

    expect(eventsOf(run)).toEqual([
      { type: "session", ref: sdk.sessionId },
      { type: "text.delta", text: "Hello" },
      { type: "text.delta", text: ", world" },
      {
        type: "usage",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 3,
        cacheWriteTokens: 4,
        costUsd: 0.01,
      },
      { type: "turn.end", reason: "completed" },
    ]);
    expect(checkStream(run.events)).toEqual([]);
    expect(scripted.runs[0]?.prompts).toEqual([
      {
        type: "user",
        message: { role: "user", content: "say hello" },
        parent_tool_use_id: null,
      },
    ]);
  });

  it("splits text longer than 16 KiB and drops a sub-agent's text", async () => {
    const long = "é".repeat(10_000);
    const { adapter } = setup([
      [
        { send: sdk.init() },
        { send: sdk.text(long) },
        { send: sdk.text("from a sub-agent", "toolu_parent") },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter);
    const deltas = eventsOf(run).filter(
      (event): event is { type: "text.delta"; text: string } =>
        (event as AdapterEvent).type === "text.delta",
    );

    expect(
      deltas.map(({ text }) => new TextEncoder().encode(text).length),
    ).toEqual([16 * 1024, 20_000 - 16 * 1024]);
    expect(deltas.map(({ text }) => text).join("")).toBe(long);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("names the session again when the CLI reports a new id", async () => {
    const other = "4f1e2d3c-0000-4000-8000-000000000002";
    const { adapter } = setup([
      [
        { send: sdk.init() },
        { send: sdk.init({ session_id: other }) },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(
      eventsOf(run).filter(
        (event) => (event as AdapterEvent).type === "session",
      ),
    ).toEqual([
      { type: "session", ref: sdk.sessionId },
      { type: "session", ref: other },
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("reports the cost of each turn, not the session's running total", async () => {
    const harness = startAdapter(
      setup([
        [{ send: sdk.init() }, { send: sdk.result({ total_cost_usd: 0.25 }) }],
        [{ send: sdk.init() }, { send: sdk.result({ total_cost_usd: 0.75 }) }],
      ]).adapter,
    );
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();

    expect(
      harness.events
        .map(({ event }) => event)
        .flatMap((event) => (event.type === "usage" ? [event.costUsd] : [])),
    ).toEqual([0.25, 0.5]);
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("a turn with a tool call", () => {
  const toolTurn: ScriptStep[] = [
    { send: sdk.init() },
    {
      send: sdk.toolUse("toolu_01", "Read", { file_path: "/work/notes.md" }),
    },
    {
      ask: {
        tool: "Read",
        input: { file_path: "/work/notes.md" },
        toolUseID: "toolu_01",
        requestId: "req-1",
      },
    },
    { send: sdk.toolResult("toolu_01") },
    { send: sdk.text("Done.") },
    { send: sdk.result() },
  ];

  it("asks the turn's decider and runs the tool when it allows", async () => {
    const asked: PermissionRequest[] = [];
    const { adapter, scripted } = setup([toolTurn]);
    const run = await runTurn(adapter, {
      decider: (request, signal, context) => {
        asked.push(request);
        return allow(request, signal, context);
      },
    });

    expect(asked).toEqual([
      {
        request: permissionRequestId.parse("req-1"),
        call: toolCallId.parse("toolu_01"),
        tool: "Read",
        kind: "file.read",
        paths: ["/work/notes.md"],
        command: null,
        truncated: false,
      },
    ]);
    expect(scripted.answers).toEqual([{ behavior: "allow" }]);
    const permission = (event: unknown) =>
      (event as AdapterEvent | { type: string }).type.startsWith("permission.");
    expect(eventsOf(run).filter((event) => !permission(event))).toEqual([
      { type: "session", ref: sdk.sessionId },
      { type: "tool.start", call: "toolu_01", tool: "Read", kind: "file.read" },
      { type: "tool.end", call: "toolu_01", outcome: "ok" },
      { type: "text.delta", text: "Done." },
      expect.objectContaining({ type: "usage" }),
      { type: "turn.end", reason: "completed" },
    ]);
    expect(eventsOf(run).filter(permission)).toEqual([
      {
        type: "permission.request",
        request: "req-1",
        call: "toolu_01",
        tool: "Read",
        kind: "file.read",
        pathCount: 1,
        hasCommand: false,
      },
      {
        type: "permission.decision",
        request: "req-1",
        decision: "allow",
        by: "rule",
        reason: "inside-folder",
      },
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("denies the tool with a fixed message and ends the call as denied", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        {
          send: sdk.toolUse("toolu_02", "Bash", { command: "cat /etc/passwd" }),
        },
        {
          ask: {
            tool: "Bash",
            input: { command: "cat /etc/passwd" },
            toolUseID: "toolu_02",
            requestId: "req-2",
          },
        },
        { send: sdk.toolResult("toolu_02", true) },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(scripted.answers).toEqual([
      { behavior: "deny", message: "Aphelion denied this tool call." },
    ]);
    expect(eventsOf(run)).toContainEqual({
      type: "tool.end",
      call: "toolu_02",
      outcome: "denied",
    });
    expect(eventsOf(run).at(-1)).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(checkStream(run.events)).toEqual([]);
  });

  it("ends a call the CLI refused without asking as an error", async () => {
    const { adapter } = setup([
      [
        { send: sdk.init() },
        { send: sdk.toolUse("toolu_03", "WebFetch") },
        { send: sdk.toolResult("toolu_03", true) },
        { send: sdk.toolUse("toolu_04", "Grep") },
        { send: sdk.toolResult("toolu_04") },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(
      eventsOf(run).filter((event) =>
        (event as AdapterEvent).type.startsWith("tool."),
      ),
    ).toEqual([
      { type: "tool.start", call: "toolu_03", tool: "WebFetch", kind: "web" },
      { type: "tool.end", call: "toolu_03", outcome: "error" },
      { type: "tool.start", call: "toolu_04", tool: "Grep", kind: "file.read" },
      { type: "tool.end", call: "toolu_04", outcome: "ok" },
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("denies when the turn's decide throws or rejects", async () => {
    for (const decide of [
      () => {
        throw new Error("decide failed");
      },
      () => Promise.reject(new Error("decide failed")),
    ]) {
      const { adapter, scripted } = setup([toolTurn]);
      const session = await adapter.open({
        bot: { id: "bot-1" },
        folder: "/work",
        resume: null,
        log: () => undefined,
      });
      const events: AdapterEvent[] = [];
      for await (const event of session.turn(
        { turn: turnId.parse("t1"), text: "hi", decide },
        new AbortController().signal,
      )) {
        events.push(event);
      }
      await session.close?.();

      expect(scripted.answers).toEqual([
        { behavior: "deny", message: "Aphelion denied this tool call." },
      ]);
      expect(events.at(-1)).toEqual({ type: "turn.end", reason: "completed" });
    }
  });

  it("denies a request whose ids don't fit the contract", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        {
          ask: {
            tool: "Read",
            input: { file_path: "/work/a" },
            toolUseID: "toolu 05",
            requestId: "req-5",
          },
        },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter, { decider: allow });

    expect(scripted.answers).toEqual([
      { behavior: "deny", message: "Aphelion denied this tool call." },
    ]);
    expect(
      eventsOf(run).some(
        (event) => (event as AdapterEvent).type === "tool.start",
      ),
    ).toBe(false);
    expect(checkStream(run.events)).toEqual([]);
  });
});

describe("how a turn ends", () => {
  const cases: [string, Record<string, unknown>, AdapterEvent[]][] = [
    [
      "a refusal",
      { stop_reason: "refusal" },
      [{ type: "turn.end", reason: "refused" }],
    ],
    [
      "the turn limit",
      {
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
      },
      [{ type: "turn.end", reason: "limit" }],
    ],
    [
      "the budget",
      { subtype: "error_max_budget_usd", is_error: true },
      [{ type: "turn.end", reason: "limit" }],
    ],
    [
      "a blocking limit",
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "blocking_limit",
      },
      [{ type: "turn.end", reason: "limit" }],
    ],
    [
      "a prompt that is too long",
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "prompt_too_long",
      },
      [{ type: "turn.end", reason: "limit" }],
    ],
    [
      "an error during execution",
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "model_error",
        errors: [fakeKey],
      },
      [
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ],
    ],
    [
      "a rejected key",
      { is_error: true, api_error_status: 401, result: fakeKey },
      [
        { type: "error", code: "signed-out" },
        { type: "turn.end", reason: "error" },
      ],
    ],
    [
      "a rate limit",
      { is_error: true, api_error_status: 429 },
      [
        { type: "error", code: "rate-limited" },
        { type: "turn.end", reason: "error" },
      ],
    ],
    [
      "an abort the adapter didn't ask for",
      {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      },
      [
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ],
    ],
  ];

  it.each(cases)("maps %s", async (_name, overrides, expected) => {
    const { adapter } = setup([
      [{ send: sdk.init() }, { send: sdk.result(overrides) }],
    ]);
    const run = await runTurn(adapter);
    const tail = eventsOf(run).filter(
      (event) => !["session", "usage"].includes((event as AdapterEvent).type),
    );

    expect(tail).toEqual(expected);
    const usage = eventsOf(run).some(
      (event) => (event as AdapterEvent).type === "usage",
    );
    expect(usage).toBe(
      expected.at(-1)?.type === "turn.end" && expected.length === 1,
    );
    expect(checkStream(run.events)).toEqual([]);
  });

  it("reports one error when the CLI signals a sign-in problem twice", async () => {
    const { adapter } = setup([
      [
        { send: sdk.init() },
        { send: sdk.assistantError("authentication_failed") },
        { send: sdk.result({ is_error: true, api_error_status: 401 }) },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(eventsOf(run).slice(1)).toEqual([
      { type: "error", code: "signed-out" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("reports a rejected rate limit", async () => {
    const { adapter } = setup([
      [
        { send: sdk.init() },
        {
          send: {
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed" },
          },
        },
        {
          send: {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected" },
          },
        },
        { send: sdk.result({ is_error: true, api_error_status: 429 }) },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(eventsOf(run).slice(1)).toEqual([
      { type: "error", code: "rate-limited" },
      { type: "turn.end", reason: "error" },
    ]);
  });

  it("ends the turn with an error when the result can't be read", async () => {
    const { adapter } = setup([
      [{ send: sdk.init() }, { send: { type: "result", subtype: "success" } }],
    ]);
    const run = await runTurn(adapter);

    expect(eventsOf(run).slice(1)).toEqual([
      { type: "error", code: "vendor" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("stops a CLI that didn't start in default permission mode", async () => {
    for (const init of [
      sdk.init({ permissionMode: "bypassPermissions" }),
      sdk.init({ claude_code_version: "2.1.331" }),
    ]) {
      const { adapter, scripted } = setup([
        [
          { send: init },
          { send: sdk.text("too late") },
          { send: sdk.result() },
        ],
      ]);
      const run = await runTurn(adapter);

      expect(eventsOf(run)).toEqual([
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ]);
      expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
        true,
      );
      expect(checkStream(run.events)).toEqual([]);
    }
  });

  it("stops a CLI whose init doesn't say its mode or version", async () => {
    const { permissionMode, ...noMode } = sdk.init();
    const { claude_code_version, ...noVersion } = sdk.init();
    expect([permissionMode, claude_code_version]).toEqual([
      "default",
      "2.1.330",
    ]);
    for (const init of [
      noMode,
      noVersion,
      { ...sdk.init(), claude_code_version: 2.1 },
    ]) {
      const { adapter, scripted } = setup([
        [
          { send: init },
          { send: sdk.text("too late") },
          { send: sdk.result() },
        ],
      ]);
      const run = await runTurn(adapter);

      expect(eventsOf(run)).toEqual([
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ]);
      expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
        true,
      );
      expect(checkStream(run.events)).toEqual([]);
    }
  });

  it("ignores a system message that isn't an init", async () => {
    const { adapter } = setup([
      [
        { send: sdk.init() },
        {
          send: {
            type: "system",
            subtype: "status",
            session_id: sdk.sessionId,
          },
        },
        { send: sdk.text("Hello") },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(eventsOf(run)).toContainEqual({ type: "text.delta", text: "Hello" });
    expect(eventsOf(run).at(-1)).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(checkStream(run.events)).toEqual([]);
  });
});

describe("when the session has more than the adapter gave it", () => {
  const sevenTools = [
    "Read",
    "Write",
    "Edit",
    "NotebookEdit",
    "Glob",
    "Grep",
    "Bash",
  ];

  const turnWith = (init: unknown): ScriptStep[] => [
    { send: init },
    {
      ask: {
        tool: "Read",
        input: { file_path: "/work/notes.md" },
        toolUseID: "toolu_01",
        requestId: "req-1",
      },
    },
    { send: sdk.toolUse("toolu_02", "mcp__example__tool") },
    { send: sdk.toolResult("toolu_02") },
    { send: sdk.text("too late") },
    { send: sdk.result() },
  ];

  const allowingAdapter = (turns: readonly (readonly ScriptStep[])[]) => {
    const scripted = scriptedQuery(turns);
    const adapter = claudeAdapter({
      query: scripted.query,
      env: {},
      rule: allow,
      interruptWaitMs: 50,
      closeWaitMs: 100,
    });
    return { scripted, adapter };
  };

  const hookOf = (options: { hooks?: unknown } | undefined): HookCallback => {
    const hooks = options?.hooks as
      { PreToolUse?: { hooks: HookCallback[] }[] } | undefined;
    const hook = hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error("no PreToolUse hook");
    return hook;
  };

  const blocked = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Aphelion denied this tool call.",
    },
  };

  const askHook = (
    hook: HookCallback,
    call: {
      tool?: string;
      mcpServer?: { name: string; source: string };
      signal?: AbortSignal;
    } = {},
  ) =>
    hook(
      {
        hook_event_name: "PreToolUse",
        session_id: sdk.sessionId,
        transcript_path: "/home/bot/.claude/projects/x.jsonl",
        cwd: "/work",
        tool_name: call.tool ?? "Read",
        tool_input: { file_path: "/work/notes.md" },
        tool_use_id: "toolu_09",
        ...(call.mcpServer ? { mcp_server: call.mcpServer } : {}),
      },
      "toolu_09",
      { signal: call.signal ?? new AbortController().signal },
    );

  const askCanUseTool = (
    options: Options | undefined,
    call: {
      tool?: string;
      mcpServer?: { name: string; source: string };
      signal?: AbortSignal;
    } = {},
  ) => {
    const canUseTool = options?.canUseTool;
    if (!canUseTool) throw new Error("no canUseTool");
    return canUseTool(
      call.tool ?? "Read",
      { file_path: "/work/notes.md" },
      {
        signal: call.signal ?? new AbortController().signal,
        toolUseID: "toolu_10",
        requestId: "req-10",
        ...(call.mcpServer ? { mcpServer: call.mcpServer } : {}),
      },
    );
  };

  const held = () => {
    const reached = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const step: ScriptStep = {
      hold: {
        reached: () => {
          reached.resolve(undefined);
        },
        release: release.promise,
      },
    };
    return {
      step,
      reached: reached.promise,
      release: () => {
        release.resolve(undefined);
      },
    };
  };

  const pending = async (work: Promise<unknown>) =>
    !(await settlesWithin(work, 20));

  const allowed = { behavior: "allow" };

  const denied = {
    behavior: "deny",
    message: "Aphelion denied this tool call.",
  };

  const dirtyInit = sdk.init({ tools: [...sevenTools, "mcp__example__tool"] });

  const refused = [
    {
      name: "a tool outside the seven",
      init: sdk.init({ tools: [...sevenTools, "mcp__example__tool"] }),
      log: "the session reported 1 tools, 0 MCP servers and 0 plugins that Aphelion didn't give it, so the adapter stopped it",
    },
    {
      name: "an MCP server",
      init: sdk.init({
        mcp_servers: [
          { name: "example", status: "needs-auth", source: "claudeai" },
        ],
      }),
      log: "the session reported 0 tools, 1 MCP servers and 0 plugins that Aphelion didn't give it, so the adapter stopped it",
    },
    {
      name: "a plugin that isn't built in",
      init: sdk.init({
        plugins: [
          {
            name: "example-plugin",
            path: "/home/bot/.claude/plugins/synced/example-plugin",
          },
        ],
      }),
      log: "the session reported 0 tools, 0 MCP servers and 1 plugins that Aphelion didn't give it, so the adapter stopped it",
    },
    {
      name: "a plugin at the built-in path whose name isn't a built-in's",
      init: sdk.init({
        plugins: [{ name: "example-plugin", path: "builtin" }],
      }),
      log: "the session reported 0 tools, 0 MCP servers and 1 plugins that Aphelion didn't give it, so the adapter stopped it",
    },
  ];

  for (const entry of refused) {
    it(`stops a session that reports ${entry.name}, and runs no tool`, async () => {
      const { adapter, scripted } = allowingAdapter([turnWith(entry.init)]);
      const run = await runTurn(adapter, { decider: allow });

      expect(eventsOf(run)).toEqual([
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ]);
      expect(scripted.answers).not.toContainEqual({ behavior: "allow" });
      expect(await askHook(hookOf(scripted.runs[0]?.options))).toEqual(blocked);
      expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
        true,
      );
      expect(run.logs).toContain(entry.log);
      expect(run.logs.join("\n")).not.toContain("example");
      expect(checkStream(run.events)).toEqual([]);
    });
  }

  it("stops a session whose init doesn't list its tools, MCP servers or plugins", async () => {
    for (const field of ["tools", "mcp_servers", "plugins"] as const) {
      const { [field]: listed, ...missing } = sdk.init();
      expect(listed).toEqual(field === "tools" ? ["Read", "Bash"] : []);
      const { adapter, scripted } = allowingAdapter([turnWith(missing)]);
      const run = await runTurn(adapter, { decider: allow });

      expect(eventsOf(run)).toEqual([
        { type: "error", code: "vendor" },
        { type: "turn.end", reason: "error" },
      ]);
      expect(scripted.answers).not.toContainEqual({ behavior: "allow" });
    }
  });

  it("stops a session whose init names no plugin", async () => {
    const { adapter, scripted } = allowingAdapter([
      turnWith(sdk.init({ plugins: [{ path: "builtin" }] })),
    ]);
    const run = await runTurn(adapter, { decider: allow });

    expect(eventsOf(run)).toEqual([
      { type: "error", code: "vendor" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(scripted.answers).not.toContainEqual({ behavior: "allow" });
  });

  it("holds a tool call that comes before the init until the adapter has checked it", async () => {
    for (const [init, answer] of [
      [sdk.init(), {}],
      [sdk.init({ tools: ["mcp__example__tool"] }), blocked],
    ] as const) {
      const { adapter, scripted } = allowingAdapter([
        [{ send: init }, { send: sdk.result() }],
      ]);
      const harness = startAdapter(adapter);
      await harness.initialize();
      const early = askHook(hookOf(scripted.runs[0]?.options));
      await harness.startTurn("t1", "hi");
      await untilTurnEnd(harness, "t1");

      expect(await early).toEqual(answer);
      await harness.shutdown();
    }
  });

  it("runs a session that reports only the seven tools and built-in plugins as before", async () => {
    const { adapter, scripted } = allowingAdapter([
      [
        {
          send: sdk.init({
            tools: sevenTools,
            skills: ["example-skill"],
            plugins: [{ name: "cc-plugin-example", path: "builtin" }],
          }),
        },
        {
          send: sdk.toolUse("toolu_01", "Read", {
            file_path: "/work/notes.md",
          }),
        },
        {
          ask: {
            tool: "Read",
            input: { file_path: "/work/notes.md" },
            toolUseID: "toolu_01",
            requestId: "req-1",
          },
        },
        { send: sdk.toolResult("toolu_01") },
        { send: sdk.result() },
      ],
    ]);
    const run = await runTurn(adapter, { decider: allow });

    expect(scripted.answers).toEqual([{ behavior: "allow" }]);
    expect(run.logs).toContain("the session reported 1 skills");
    expect(run.logs.join("\n")).not.toContain("example");
    expect(eventsOf(run)).toContainEqual({
      type: "tool.end",
      call: "toolu_01",
      outcome: "ok",
    });
    expect(eventsOf(run).at(-1)).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(checkStream(run.events)).toEqual([]);
  });

  describe("trust lasts one turn", () => {
    it("holds canUseTool before the init until the adapter has checked it", async () => {
      for (const [init, answer] of [
        [sdk.init(), allowed],
        [dirtyInit, denied],
      ] as const) {
        const gate = held();
        const { adapter, scripted } = allowingAdapter([
          [gate.step, { send: init }, { send: sdk.result() }],
        ]);
        const harness = startAdapter(adapter, { decider: allow });
        await harness.initialize();
        await harness.startTurn("t1", "hi");
        await gate.reached;
        const early = askCanUseTool(scripted.runs[0]?.options);

        expect(await pending(early)).toBe(true);
        gate.release();
        expect(await early).toEqual(answer);
        await untilTurnEnd(harness, "t1");
        await harness.shutdown();
      }
    });

    it("holds a second turn's tool calls until that turn's init is checked", async () => {
      for (const [init, hookAnswer, answer] of [
        [sdk.init(), {}, allowed],
        [dirtyInit, blocked, denied],
      ] as const) {
        const gate = held();
        const { adapter, scripted } = allowingAdapter([
          [{ send: sdk.init() }, { send: sdk.result() }],
          [gate.step, { send: init }, { send: sdk.result() }],
        ]);
        const harness = startAdapter(adapter, { decider: allow });
        await harness.initialize();
        await harness.startTurn("t1", "one");
        await untilTurnEnd(harness, "t1");
        await harness.startTurn("t2", "two");
        await gate.reached;
        const options = scripted.runs[0]?.options;
        const fromHook = askHook(hookOf(options));
        const fromCanUseTool = askCanUseTool(options);

        expect(await pending(fromHook)).toBe(true);
        expect(await pending(fromCanUseTool)).toBe(true);
        gate.release();
        expect(await fromHook).toEqual(hookAnswer);
        expect(await fromCanUseTool).toEqual(answer);
        await untilTurnEnd(harness, "t2");
        await harness.shutdown();
      }
    });

    it("denies every call after a later init reports more, in the same turn or the next", async () => {
      for (const turns of [
        [[{ send: sdk.init() }, { send: dirtyInit }, { send: sdk.result() }]],
        [
          [{ send: sdk.init() }, { send: sdk.result() }],
          [{ send: dirtyInit }, { send: sdk.result() }],
        ],
      ]) {
        const { adapter, scripted } = allowingAdapter(turns);
        const harness = startAdapter(adapter, { decider: allow });
        await harness.initialize();
        for (const [index] of turns.entries()) {
          await harness.startTurn(`t${String(index)}`, "hi");
          await untilTurnEnd(harness, `t${String(index)}`);
        }
        const options = scripted.runs[0]?.options;

        expect(harness.events.at(-1)?.event).toEqual({
          type: "turn.end",
          reason: "error",
        });
        expect(options?.abortController?.signal.aborted).toBe(true);
        expect(await askHook(hookOf(options))).toEqual(blocked);
        await harness.shutdown();
      }
    });

    it("stops the CLI when an init between turns reports more", async () => {
      const gate = held();
      const { adapter, scripted } = allowingAdapter([
        [
          { send: sdk.init() },
          { send: sdk.result() },
          gate.step,
          { send: dirtyInit },
          { hang: true },
        ],
        [{ send: sdk.init() }, { send: sdk.result() }],
      ]);
      const harness = startAdapter(adapter, { decider: allow });
      await harness.initialize();
      await harness.startTurn("t1", "one");
      await untilTurnEnd(harness, "t1");
      await gate.reached;
      const signal = scripted.runs[0]?.options.abortController?.signal;
      if (!signal) throw new Error("no abort signal");
      const stopped = whenAborted(signal, true).done;
      gate.release();

      expect(await settlesWithin(stopped, 1000)).toBe(true);
      expect(await askHook(hookOf(scripted.runs[0]?.options))).toEqual(blocked);
      expect(harness.logs).toContain(
        "the session reported 1 tools, 0 MCP servers and 0 plugins that Aphelion didn't give it, so the adapter stopped it",
      );
      await harness.startTurn("t2", "two");
      await untilTurnEnd(harness, "t2");

      expect(scripted.runs).toHaveLength(2);
      expect(harness.events.at(-1)?.event).toEqual({
        type: "turn.end",
        reason: "completed",
      });
      await harness.shutdown();
    });

    it("ends a call's wait for the init when the call's signal aborts", async () => {
      const gate = held();
      const { adapter, scripted } = allowingAdapter([
        [gate.step, { send: sdk.init() }, { send: sdk.result() }],
      ]);
      const harness = startAdapter(adapter, { decider: allow });
      await harness.initialize();
      await harness.startTurn("t1", "hi");
      await gate.reached;
      const options = scripted.runs[0]?.options;
      const hookCall = new AbortController();
      const canUseToolCall = new AbortController();
      const fromHook = askHook(hookOf(options), { signal: hookCall.signal });
      const fromCanUseTool = askCanUseTool(options, {
        signal: canUseToolCall.signal,
      });
      hookCall.abort();
      canUseToolCall.abort();

      expect(await settlesWithin(fromHook, 1000)).toBe(true);
      expect(await settlesWithin(fromCanUseTool, 1000)).toBe(true);
      expect(await fromHook).toEqual(blocked);
      expect(await fromCanUseTool).toEqual(denied);
      gate.release();
      await untilTurnEnd(harness, "t1");
      await harness.shutdown();
    });

    it("blocks a hook waiting for the init when the CLI exits without one", async () => {
      const gate = held();
      const { adapter, scripted } = allowingAdapter([
        [gate.step, { exit: true }],
      ]);
      const harness = startAdapter(adapter, { decider: allow });
      await harness.initialize();
      await harness.startTurn("t1", "hi");
      await gate.reached;
      const early = askHook(hookOf(scripted.runs[0]?.options));

      expect(await pending(early)).toBe(true);
      gate.release();
      expect(await early).toEqual(blocked);
      await untilTurnEnd(harness, "t1");
      await harness.shutdown();
    });
  });

  describe("each tool call", () => {
    const outside = [
      { name: "a tool outside the seven", call: { tool: "ExampleTool" } },
      {
        name: "a call served by an MCP server",
        call: { mcpServer: { name: "example", source: "claudeai" } },
      },
    ];

    for (const entry of outside) {
      it(`denies ${entry.name} from the hook and from canUseTool`, async () => {
        const gate = held();
        const { adapter, scripted } = allowingAdapter([
          [{ send: sdk.init() }, gate.step, { send: sdk.result() }],
        ]);
        const harness = startAdapter(adapter, { decider: allow });
        await harness.initialize();
        await harness.startTurn("t1", "hi");
        await gate.reached;
        const options = scripted.runs[0]?.options;

        expect(await askHook(hookOf(options), entry.call)).toEqual(blocked);
        expect(await askCanUseTool(options, entry.call)).toEqual(denied);
        expect(await askHook(hookOf(options))).toEqual({});
        expect(await askCanUseTool(options)).toEqual(allowed);
        gate.release();
        await untilTurnEnd(harness, "t1");
        await harness.shutdown();
      });
    }
  });
});

describe("when the CLI stops", () => {
  it("reports a missing binary", async () => {
    const { adapter } = setup([
      [
        {
          throws: Object.assign(new Error("not found"), {
            errorClass: "executable_not_found",
          }),
        },
      ],
    ]);
    const run = await runTurn(adapter);

    expect(eventsOf(run)).toEqual([
      { type: "error", code: "cli-not-found" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(run.logs).toContain("the Claude CLI stopped: executable_not_found");
  });

  it("reports an exit and resumes the session in a new process on the next turn", async () => {
    const { adapter, scripted } = setup([
      [{ send: sdk.init() }, { send: sdk.text("partial") }, { exit: true }],
      completed,
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();

    const first = harness.events
      .filter(({ turn }) => turn === "t1")
      .map(({ event }) => event);
    expect(first.slice(-2)).toEqual([
      { type: "error", code: "cli-exited" },
      { type: "turn.end", reason: "error" },
    ]);
    expect(scripted.runs).toHaveLength(2);
    expect(scripted.runs[0]?.options.resume).toBeUndefined();
    expect(scripted.runs[1]?.options.resume).toBe(sdk.sessionId);
    expect(harness.events.at(-1)?.event).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("opening a session", () => {
  it("starts the CLI with the options every query gets", async () => {
    const { adapter, scripted } = setup([completed], {
      HOME: "/var/lib/aphelion-bots",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: fakeKey,
    });
    await runTurn(adapter);
    const options = scripted.runs[0]?.options;

    expect(options).toMatchObject({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      cwd: "/work",
      permissionMode: "default",
      settingSources: [],
      verbatimPrompts: true,
    });
    expect(options).not.toHaveProperty("allowedTools");
    expect(options?.env).toEqual({
      HOME: "/var/lib/aphelion-bots",
      PATH: "/usr/bin",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
  });

  it("resumes a saved Claude session and refuses a ref of another form", async () => {
    for (const [saved, resume] of [
      [sdk.sessionId, sdk.sessionId],
      ["notes.txt", undefined],
    ] as const) {
      const { adapter, scripted } = setup([completed]);
      const harness = startAdapter(adapter);
      await harness.initialize(saved);
      await harness.shutdown();

      expect(scripted.runs[0]?.options.resume).toBe(resume);
      expect(
        harness.logs.includes(
          "the saved session ref isn't a Claude session id, so the bot starts a new session",
        ),
      ).toBe(resume === undefined);
    }
  });

  it("ends the CLI's input on shutdown", async () => {
    const { adapter, scripted } = setup([completed]);
    await runTurn(adapter);

    expect(scripted.runs).toHaveLength(1);
    expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
      false,
    );
  });

  it("aborts a CLI that doesn't stop after its input ends", async () => {
    const { adapter, scripted } = setup([
      [{ send: sdk.init() }, { hang: true }],
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ event }) => event.type === "session");
    await harness.shutdown();

    expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
      true,
    );
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("keys stay out of events and logs", () => {
  it("never shows a key from the environment, the CLI's stderr or its errors", async () => {
    const leak = Object.assign(new Error(`401 invalid x-api-key ${fakeKey}`), {
      errorClass: "process_exited_nonzero",
    });
    const scripted = scriptedQuery([
      [
        { send: sdk.init() },
        { send: sdk.assistantError(fakeKey) },
        {
          send: {
            type: "auth_status",
            isAuthenticating: false,
            output: [fakeKey],
            error: fakeKey,
          },
        },
        {
          send: sdk.toolUse("toolu_09", "Bash", { command: `echo ${fakeKey}` }),
        },
        {
          ask: {
            tool: "Bash",
            input: { command: `echo ${fakeKey}` },
            toolUseID: "toolu_09",
            requestId: "req-9",
          },
        },
        { throws: leak },
      ],
      [{ throws: leak }],
    ]);
    const adapter = claudeAdapter({
      query: (params) => {
        params.options.stderr?.(`Error: invalid key ${fakeKey}\n`);
        return scripted.query(params);
      },
      env: { HOME: "/var/lib/aphelion-bots", ANTHROPIC_API_KEY: fakeKey },
      rule: denyAll,
      interruptWaitMs: 50,
      closeWaitMs: 100,
    });
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();
    await harness.done;

    const seen = JSON.stringify([
      harness.events,
      harness.logs,
      harness.problems,
      scripted.runs.map(({ options }) => options.env),
    ]);
    expect(seen).not.toContain("sk-ant");
    expect(harness.logs).toContain("the CLI wrote 1 lines to stderr");
    expect(harness.events.map(({ event }) => event.type)).toContain("error");
    expect(checkStream(harness.events)).toEqual([]);
  });
});

describe("cancel", () => {
  it("interrupts the CLI and keeps the session when the result arrives", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        { send: sdk.text("working") },
        { waitForInterrupt: true },
        {
          send: sdk.result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_streaming",
          }),
        },
      ],
      completed,
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ event }) => event.type === "text.delta");
    await harness.cancel("t1");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();

    const ends = harness.events.flatMap(({ event }) =>
      event.type === "turn.end" ? [event.reason] : [],
    );
    expect(ends).toEqual(["cancelled", "completed"]);
    expect(scripted.runs).toHaveLength(1);
    expect(scripted.runs[0]?.interrupts).toBe(1);
    expect(checkStream(harness.events)).toEqual([]);
  });

  it("aborts the CLI when no result comes, and resumes in a new process", async () => {
    const { adapter, scripted } = setup([
      [{ send: sdk.init() }, { send: sdk.text("working") }, { hang: true }],
      completed,
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ event }) => event.type === "text.delta");
    await harness.cancel("t1");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();

    const ends = harness.events.flatMap(({ event }) =>
      event.type === "turn.end" ? [event.reason] : [],
    );
    expect(ends).toEqual(["cancelled", "completed"]);
    expect(scripted.runs).toHaveLength(2);
    expect(scripted.runs[0]?.options.abortController?.signal.aborted).toBe(
      true,
    );
    expect(scripted.runs[1]?.options.resume).toBe(sdk.sessionId);
    expect(harness.logs).not.toContain("the Claude CLI stopped: aborted");
    expect(checkStream(harness.events)).toEqual([]);
  });

  it("denies a tool that is waiting for a decision", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        { send: sdk.toolUse("toolu_07", "Write", { file_path: "/work/a" }) },
        {
          ask: {
            tool: "Write",
            input: { file_path: "/work/a" },
            toolUseID: "toolu_07",
            requestId: "req-7",
          },
        },
        { send: sdk.toolResult("toolu_07", true) },
        { waitForInterrupt: true },
        {
          send: sdk.result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_tools",
          }),
        },
      ],
    ]);
    const harness = startAdapter(adapter, {
      decider: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({
              decision: "allow",
              by: "owner",
              reason: "inside-folder",
            });
          });
        }),
    });
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(
      ({ event }) => event.type === "permission.request",
    );
    await harness.cancel("t1");
    await untilTurnEnd(harness, "t1");
    await harness.shutdown();

    expect(scripted.answers).toEqual([
      { behavior: "deny", message: "Aphelion denied this tool call." },
    ]);
    expect(harness.events.map(({ event }) => event)).toContainEqual({
      type: "permission.decision",
      request: "req-7",
      decision: "deny",
      by: "default",
      reason: "cancelled",
    });
    expect(harness.events.map(({ event }) => event)).toContainEqual({
      type: "tool.end",
      call: "toolu_07",
      outcome: "denied",
    });
    expect(harness.events.at(-1)?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    expect(checkStream(harness.events)).toEqual([]);
  });

  it("ends a call asked after the cancel as an error, since no decision was announced", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        { send: sdk.toolUse("toolu_08", "Write", { file_path: "/work/a" }) },
        { waitForInterrupt: true },
        {
          ask: {
            tool: "Write",
            input: { file_path: "/work/a" },
            toolUseID: "toolu_08",
            requestId: "req-8",
          },
        },
        { send: sdk.toolResult("toolu_08", true) },
        {
          send: sdk.result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_tools",
          }),
        },
      ],
    ]);
    const harness = startAdapter(adapter, { decider: allow });
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ event }) => event.type === "tool.start");
    await harness.cancel("t1");
    await untilTurnEnd(harness, "t1");
    await harness.shutdown();

    const events = harness.events.map(({ event }) => event);
    expect(scripted.answers).toEqual([
      { behavior: "deny", message: "Aphelion denied this tool call." },
    ]);
    expect(events.some(({ type }) => type.startsWith("permission."))).toBe(
      false,
    );
    expect(events).toContainEqual({
      type: "tool.end",
      call: "toolu_08",
      outcome: "error",
    });
    expect(checkStream(harness.events)).toEqual([]);
  });

  it("ends as an error a call from an earlier turn that the runtime denies without a decision", async () => {
    const { adapter, scripted } = setup([
      [
        { send: sdk.init() },
        { send: sdk.toolUse("toolu_bg", "Bash", { command: "sleep 60" }) },
        { send: sdk.result() },
      ],
      [
        { send: sdk.init() },
        {
          ask: {
            tool: "Bash",
            input: { command: "sleep 60" },
            toolUseID: "toolu_bg",
            requestId: "req-bg",
          },
        },
        { send: sdk.toolResult("toolu_bg", true) },
        { send: sdk.result() },
      ],
    ]);
    const harness = startAdapter(adapter, { decider: allow });
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await untilTurnEnd(harness, "t1");
    await harness.startTurn("t2", "two");
    await untilTurnEnd(harness, "t2");
    await harness.shutdown();

    const events = harness.events.map(({ event }) => event);
    expect(scripted.answers).toEqual([
      { behavior: "deny", message: "Aphelion denied this tool call." },
    ]);
    expect(events.some(({ type }) => type.startsWith("permission."))).toBe(
      false,
    );
    expect(events).toContainEqual({
      type: "tool.end",
      call: "toolu_bg",
      outcome: "error",
    });
    expect(harness.events.at(-1)?.event).toEqual({
      type: "turn.end",
      reason: "completed",
    });
    expect(checkStream(harness.events)).toEqual([]);
  });

  it("counts the SDK's abort error during a cancel as the cancel", async () => {
    const { adapter } = setup([
      [
        { send: sdk.init() },
        { waitForInterrupt: true },
        { throws: abortedError() },
      ],
    ]);
    const harness = startAdapter(adapter);
    await harness.initialize();
    await harness.startTurn("t1", "one");
    await harness.untilEvent(({ event }) => event.type === "session");
    await harness.cancel("t1");
    await untilTurnEnd(harness, "t1");
    await harness.shutdown();

    expect(harness.events.at(-1)?.event).toEqual({
      type: "turn.end",
      reason: "cancelled",
    });
    expect(checkStream(harness.events)).toEqual([]);
  });
});
