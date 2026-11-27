import type { BotEvent } from "@aphelion/protocol";
import { describe, expect, test } from "vitest";
import { createRenderer, stripControl } from "./render";

const screen = () => {
  const log: string[] = [];
  const renderer = createRenderer({
    out: (text) => log.push(`out:${text}`),
    err: (line) => log.push(`err:${line}`),
  });
  return { log, renderer };
};

const show = (...events: BotEvent[]) => {
  const { log, renderer } = screen();
  for (const event of events) renderer.event(event);
  return log;
};

describe("stripControl", () => {
  test("keeps new lines and tabs and drops the other control characters", () => {
    expect(stripControl("a\tb\nc\u001b[31md\u0007e\u0000f\u009bg\r")).toBe(
      "a\tb\nc[31mdefg",
    );
  });

  test("keeps ordinary text in any script", () => {
    expect(stripControl("héllo 世界 🙂")).toBe("héllo 世界 🙂");
  });
});

describe("the renderer", () => {
  test("writes text deltas as they come, with no added new line", () => {
    expect(
      show(
        { type: "text.delta", text: "Hel" },
        { type: "text.delta", text: "lo" },
      ),
    ).toEqual(["out:Hel", "out:lo"]);
  });

  test("starts a new line before a tool line when text is open", () => {
    expect(
      show(
        { type: "text.delta", text: "Let me look" },
        { type: "tool.start", call: "c1", tool: "Read", kind: "file.read" },
      ),
    ).toEqual([
      "out:Let me look",
      "out:\n",
      "out:[tool] start Read (file.read)\n",
    ]);
  });

  test("adds no blank line when the text already ended its line", () => {
    expect(
      show(
        { type: "text.delta", text: "done\n" },
        { type: "tool.start", call: "c1", tool: "Read", kind: "file.read" },
      ),
    ).toEqual(["out:done\n", "out:[tool] start Read (file.read)\n"]);
  });

  test("names the tool again when the call ends", () => {
    expect(
      show(
        { type: "tool.start", call: "c1", tool: "Bash", kind: "shell" },
        { type: "tool.end", call: "c1", outcome: "ok" },
        { type: "tool.end", call: "c9", outcome: "error" },
      ),
    ).toEqual([
      "out:[tool] start Bash (shell)\n",
      "out:[tool] end Bash: ok\n",
      "out:[tool] end c9: error\n",
    ]);
  });

  test("shows a permission request and its decision without paths or commands", () => {
    expect(
      show(
        {
          type: "permission.request",
          request: "r1",
          call: "c1",
          tool: "Bash",
          kind: "shell",
          pathCount: 2,
          hasCommand: true,
        },
        {
          type: "permission.decision",
          request: "r1",
          decision: "deny",
          by: "default",
          reason: "no-decider",
        },
      ),
    ).toEqual([
      "out:[permission] Bash asks (shell, paths: 2, command: yes)\n",
      "out:[permission] deny by default (no-decider)\n",
    ]);
  });

  test("shows usage with the cost only when there is one", () => {
    expect(
      show(
        {
          type: "usage",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 3,
          cacheWriteTokens: 4,
          costUsd: 0.0123,
        },
        {
          type: "usage",
          inputTokens: 1,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
        },
      ),
    ).toEqual([
      "out:[usage] in=10 out=20 cache=3/4 cost=$0.0123\n",
      "out:[usage] in=1 out=2 cache=0/0\n",
    ]);
  });

  test("puts an error on standard error after finishing the open line", () => {
    expect(
      show(
        { type: "text.delta", text: "half" },
        { type: "error", code: "signed-out" },
      ),
    ).toEqual([
      "out:half",
      "out:\n",
      "err:[error] the bot's AI tool is signed out",
    ]);
  });

  test("ends a turn with its reason on a line of its own", () => {
    expect(
      show(
        { type: "text.delta", text: "hi" },
        { type: "turn.end", reason: "cancelled" },
      ),
    ).toEqual(["out:hi", "out:\n", "out:[turn] cancelled\n"]);
  });

  test("shows a notice and strips control characters from it", () => {
    const { log, renderer } = screen();
    renderer.notice("back\u001b[2J soon");
    expect(log).toEqual(["out:[notice] back[2J soon\n"]);
  });

  test("strips control characters from bot text", () => {
    expect(show({ type: "text.delta", text: "a\u001b]0;x\u0007b" })).toEqual([
      "out:a]0;xb",
    ]);
  });

  test("finishes the open line before a status line", () => {
    const { log, renderer } = screen();
    renderer.event({ type: "text.delta", text: "open" });
    renderer.status("connection lost");
    expect(log).toEqual(["out:open", "out:\n", "err:connection lost"]);
  });
});
