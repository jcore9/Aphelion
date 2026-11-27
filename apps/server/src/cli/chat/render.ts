import type { BotEvent } from "@aphelion/protocol";

export interface Screen {
  readonly out: (text: string) => void;
  readonly err: (line: string) => void;
}

const keeps = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return (
    code === 9 || code === 10 || !(code < 32 || (code >= 127 && code <= 159))
  );
};

export const stripControl = (text: string) =>
  Array.from(text).filter(keeps).join("");

const errorMessages = {
  "cli-not-found": "the bot's AI tool isn't installed",
  "cli-exited": "the bot's AI tool stopped",
  "signed-out": "the bot's AI tool is signed out",
  "rate-limited": "the AI tool's vendor is limiting requests",
  vendor: "the AI tool's vendor reported an error",
  adapter: "the bot's adapter failed",
} as const;

export const createRenderer = (screen: Screen) => {
  let open = false;
  const tools = new Map<string, string>();

  const closeLine = () => {
    if (open) {
      screen.out("\n");
      open = false;
    }
  };
  const line = (text: string) => {
    closeLine();
    screen.out(`${stripControl(text)}\n`);
  };
  const errorLine = (text: string) => {
    closeLine();
    screen.err(stripControl(text));
  };

  const event = (item: BotEvent) => {
    switch (item.type) {
      case "text.delta": {
        const text = stripControl(item.text);
        if (text === "") return;
        screen.out(text);
        open = !text.endsWith("\n");
        return;
      }
      case "tool.start":
        tools.set(item.call, item.tool);
        line(`[tool] start ${item.tool} (${item.kind})`);
        return;
      case "tool.end":
        line(
          `[tool] end ${tools.get(item.call) ?? item.call}: ${item.outcome}`,
        );
        tools.delete(item.call);
        return;
      case "permission.request":
        line(
          `[permission] ${item.tool} asks (${item.kind}, paths: ${String(item.pathCount)}, command: ${item.hasCommand ? "yes" : "no"})`,
        );
        return;
      case "permission.decision":
        line(`[permission] ${item.decision} by ${item.by} (${item.reason})`);
        return;
      case "usage": {
        const cost =
          item.costUsd === null ? "" : ` cost=$${String(item.costUsd)}`;
        line(
          `[usage] in=${String(item.inputTokens)} out=${String(item.outputTokens)} cache=${String(item.cacheReadTokens)}/${String(item.cacheWriteTokens)}${cost}`,
        );
        return;
      }
      case "error":
        errorLine(`[error] ${errorMessages[item.code]}`);
        return;
      case "turn.end":
        line(`[turn] ${item.reason}`);
        return;
    }
  };

  return {
    event,
    notice: (message: string) => {
      line(`[notice] ${message}`);
    },
    info: line,
    status: errorLine,
  };
};
