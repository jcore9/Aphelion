import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HookCallback,
  PermissionUpdate,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { folderRule } from "@aphelion/plugin-sdk";
import { checkStream, runTurn } from "@aphelion/plugin-sdk/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeAdapter } from "./adapter.ts";
import { realpathOrMissing } from "./files.ts";
import { scriptedQuery, sdk, type ScriptStep } from "./scripted-query.ts";

type Verdict = "allow" | "deny";

interface Case {
  readonly name: string;
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly expected: Verdict;
}

let base = "";
let folder = "";
let outside = "";

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "aphelion-rule-")));
  folder = join(base, "bot");
  outside = join(base, "other");
  await mkdir(join(folder, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(folder, "notes.md"), "notes");
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(folder, "out"));
  await symlink(join(outside, "planted.txt"), join(folder, "planted"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const cases = (): readonly Case[] => [
  {
    name: "a read inside",
    tool: "Read",
    input: { file_path: join(folder, "notes.md") },
    expected: "allow",
  },
  {
    name: "a relative read inside",
    tool: "Read",
    input: { file_path: "notes.md" },
    expected: "allow",
  },
  {
    name: "a read outside",
    tool: "Read",
    input: { file_path: join(outside, "secret.txt") },
    expected: "deny",
  },
  {
    name: "a read that climbs out with ..",
    tool: "Read",
    input: { file_path: "src/../../other/secret.txt" },
    expected: "deny",
  },
  {
    name: "an absolute read outside",
    tool: "Read",
    input: { file_path: "/etc/passwd" },
    expected: "deny",
  },
  {
    name: "a read through a link inside that points outside",
    tool: "Read",
    input: { file_path: join(folder, "out", "secret.txt") },
    expected: "deny",
  },
  {
    name: "a read of the home folder",
    tool: "Read",
    input: { file_path: "~/.claude/.credentials.json" },
    expected: "deny",
  },
  {
    name: "a new file in a folder inside",
    tool: "Write",
    input: { file_path: join(folder, "src", "new", "a.ts"), content: "x" },
    expected: "allow",
  },
  {
    name: "a new file whose parent is outside",
    tool: "Write",
    input: { file_path: join(outside, "new.txt"), content: "x" },
    expected: "deny",
  },
  {
    name: "a write through a broken link to outside",
    tool: "Write",
    input: { file_path: join(folder, "planted"), content: "x" },
    expected: "deny",
  },
  {
    name: "an edit inside",
    tool: "Edit",
    input: {
      file_path: join(folder, "notes.md"),
      old_string: "notes",
      new_string: "more",
    },
    expected: "allow",
  },
  {
    name: "a notebook edit outside",
    tool: "NotebookEdit",
    input: { notebook_path: join(outside, "n.ipynb"), new_source: "x" },
    expected: "deny",
  },
  {
    name: "a Glob inside with no path",
    tool: "Glob",
    input: { pattern: "**/*.md" },
    expected: "allow",
  },
  {
    name: "a Glob of /etc/*",
    tool: "Glob",
    input: { pattern: "/etc/*" },
    expected: "deny",
  },
  {
    name: "a Glob of ../*",
    tool: "Glob",
    input: { pattern: "../*" },
    expected: "deny",
  },
  {
    name: "a Glob inside a path outside",
    tool: "Glob",
    input: { pattern: "*.txt", path: outside },
    expected: "deny",
  },
  {
    name: "a Grep with no path, whose regex looks like a path",
    tool: "Grep",
    input: { pattern: "/etc/passwd" },
    expected: "allow",
  },
  {
    name: "a Grep with a path outside",
    tool: "Grep",
    input: { pattern: "secret", path: outside },
    expected: "deny",
  },
  {
    name: "a Grep whose file filter climbs out",
    tool: "Grep",
    input: { pattern: "secret", glob: "../other/*" },
    expected: "deny",
  },
  {
    name: "a web fetch",
    tool: "WebFetch",
    input: { url: "https://example.com", prompt: "x" },
    expected: "deny",
  },
  {
    name: "a web search",
    tool: "WebSearch",
    input: { query: "x" },
    expected: "deny",
  },
  {
    name: "a shell command that names a file outside",
    tool: "Bash",
    input: { command: `cat ${join(outside, "secret.txt")}` },
    expected: "allow",
  },
  {
    name: "the to-do tool",
    tool: "TodoWrite",
    input: { todos: [] },
    expected: "deny",
  },
  {
    name: "an unknown tool",
    tool: "mcp__files__read",
    input: { path: join(folder, "notes.md") },
    expected: "deny",
  },
  {
    name: "a file tool with no path",
    tool: "Read",
    input: {},
    expected: "deny",
  },
];

const sessionWide: PermissionUpdate[] = [
  { type: "setMode", mode: "bypassPermissions", destination: "session" },
  {
    type: "addRules",
    rules: [{ toolName: "Read" }],
    behavior: "allow",
    destination: "session",
  },
];

const rule = folderRule(realpathOrMissing);

const runCases = async (all: readonly Case[]) => {
  const steps: ScriptStep[] = [{ send: sdk.init() }];
  all.forEach((entry, index) => {
    const id = `toolu_${String(index)}`;
    steps.push(
      { send: sdk.toolUse(id, entry.tool, entry.input) },
      {
        ask: {
          tool: entry.tool,
          input: entry.input,
          toolUseID: id,
          requestId: `req-${String(index)}`,
          suggestions: sessionWide,
        },
      },
      { send: sdk.toolResult(id, entry.expected === "deny") },
    );
  });
  steps.push({ send: sdk.result() });
  const scripted = scriptedQuery([steps]);
  const adapter = claudeAdapter({
    query: scripted.query,
    env: {},
    rule,
    interruptWaitMs: 50,
    closeWaitMs: 100,
  });
  const run = await runTurn(adapter, { decider: rule, folder });
  return { scripted, run };
};

const hookOf = (options: { hooks?: unknown } | undefined): HookCallback => {
  const hooks = options?.hooks as
    { PreToolUse?: { hooks: HookCallback[] }[] } | undefined;
  const hook = hooks?.PreToolUse?.[0]?.hooks[0];
  if (!hook) throw new Error("no PreToolUse hook");
  return hook;
};

const hookInput = (
  tool: string,
  input: unknown,
  id: string,
): PreToolUseHookInput => ({
  hook_event_name: "PreToolUse",
  session_id: sdk.sessionId,
  transcript_path: "/home/bot/.claude/projects/x.jsonl",
  cwd: folder,
  tool_name: tool,
  tool_input: input,
  tool_use_id: id,
});

const denied = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "Aphelion denied this tool call.",
  },
};

const ask = (hook: HookCallback, tool: string, input: unknown, id: string) =>
  hook(hookInput(tool, input, id), id, {
    signal: new AbortController().signal,
  });

describe("the first bot's fixed rule", () => {
  it("gives the answer each case expects, the same from the hook and from canUseTool", async () => {
    const all = cases();
    const { scripted, run } = await runCases(all);
    const hook = hookOf(scripted.runs[0]?.options);

    const fromCanUseTool = scripted.answers.map((answer): Verdict =>
      answer?.behavior === "allow" ? "allow" : "deny",
    );
    const fromHook = await Promise.all(
      all.map(async (entry, index): Promise<Verdict> => {
        const answer = await ask(
          hook,
          entry.tool,
          entry.input,
          `toolu_${String(index)}`,
        );
        return "hookSpecificOutput" in answer ? "deny" : "allow";
      }),
    );

    const expected = all.map(({ name, expected }) => `${name}: ${expected}`);
    const label = (verdicts: readonly Verdict[]) =>
      all.map(({ name }, index) => `${name}: ${String(verdicts[index])}`);
    expect(label(fromCanUseTool)).toEqual(expected);
    expect(label(fromHook)).toEqual(expected);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("never returns the suggested session-wide rule or mode change", async () => {
    const { scripted } = await runCases(cases());
    for (const answer of scripted.answers) {
      expect([
        { behavior: "allow" },
        { behavior: "deny", message: "Aphelion denied this tool call." },
      ]).toContainEqual(answer);
    }
  });

  it("announces each canUseTool decision as decided by the rule", async () => {
    const all = cases();
    const { run } = await runCases(all);
    const reasons = run.events.flatMap(({ event }) =>
      event.type === "permission.decision"
        ? [`${event.by} ${event.decision} ${event.reason}`]
        : [],
    );
    expect(reasons).toContain("rule allow inside-folder");
    expect(reasons).toContain("rule deny outside-folder");
    expect(reasons).toContain("rule deny web");
    expect(reasons).toContain("rule allow shell");
    expect(reasons).toContain("rule deny unknown-tool");
    expect(reasons).toHaveLength(all.length);
  });
});

describe("the PreToolUse hook", () => {
  it("stops a denied tool with the SDK's deny answer, and passes an allowed one on to canUseTool", async () => {
    const { scripted } = await runCases([]);
    const hook = hookOf(scripted.runs[0]?.options);
    expect(
      await ask(hook, "Read", { file_path: "/etc/passwd" }, "toolu_1"),
    ).toEqual(denied);
    expect(
      await ask(
        hook,
        "Read",
        { file_path: join(folder, "notes.md") },
        "toolu_2",
      ),
    ).toEqual({});
    expect(await ask(hook, "Bash", { command: "ls" }, "toolu_3")).toEqual({});
  });

  it("ends a call the hook stopped as an error, since canUseTool never announced a deny", async () => {
    const secret = { file_path: join(outside, "secret.txt") };
    const scripted = scriptedQuery([
      [
        { send: sdk.init() },
        { send: sdk.toolUse("toolu_1", "Read", secret) },
        { send: sdk.toolResult("toolu_1", true) },
        { send: sdk.result() },
      ],
    ]);
    const adapter = claudeAdapter({ query: scripted.query, env: {}, rule });
    const run = await runTurn(adapter, { decider: rule, folder });
    const hook = hookOf(scripted.runs[0]?.options);
    expect(await ask(hook, "Read", secret, "toolu_1")).toEqual(denied);
    expect(
      run.events.find(({ event }) => event.type === "tool.end")?.event,
    ).toEqual({ type: "tool.end", call: "toolu_1", outcome: "error" });
    expect(
      run.events.some(({ event }) => event.type === "permission.decision"),
    ).toBe(false);
    expect(checkStream(run.events)).toEqual([]);
  });

  it("denies a call it can't read", async () => {
    const { scripted } = await runCases([]);
    const hook = hookOf(scripted.runs[0]?.options);
    expect(await ask(hook, "Bash", "ls", "toolu_1")).toEqual(denied);
    expect(await ask(hook, "Read", null, "toolu_1")).toEqual(denied);
    expect(
      await ask(hook, "Read", { file_path: "notes.md" }, "bad id"),
    ).toEqual(denied);
    expect(
      await ask(hook, "bad name", { file_path: "notes.md" }, "toolu_1"),
    ).toEqual(denied);
  });

  it("judges paths against the bot's folder, not the cwd the hook reports", async () => {
    const { scripted } = await runCases([]);
    const hook = hookOf(scripted.runs[0]?.options);
    const secret = { file_path: join(outside, "secret.txt") };
    const moved = { ...hookInput("Read", secret, "toolu_1"), cwd: outside };
    expect(
      await hook(moved, "toolu_1", { signal: new AbortController().signal }),
    ).toEqual(denied);
  });

  it("denies when the rule fails", async () => {
    const scripted = scriptedQuery([
      [{ send: sdk.init() }, { send: sdk.result() }],
    ]);
    const adapter = claudeAdapter({
      query: scripted.query,
      env: {},
      rule: () => Promise.reject(new Error("disk gone")),
    });
    await runTurn(adapter, { folder });
    const hook = hookOf(scripted.runs[0]?.options);
    expect(
      await ask(hook, "Read", { file_path: "notes.md" }, "toolu_1"),
    ).toEqual(denied);
  });
});
