import type { ChatHost, ChatSocket, SocketEvents } from "./session";
import { connectWebSocket } from "./socket";

export const waitFor = async (
  what: string,
  check: () => boolean,
  millis = 8_000,
) => {
  const deadline = Date.now() + millis;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

export const lineQueue = () => {
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  return {
    push: (line: string) => {
      lines.push(line);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const line = lines.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
};

export interface TestHost extends ChatHost {
  readonly stdout: () => string;
  readonly stderr: () => string[];
  readonly everything: () => string;
  readonly sent: () => Record<string, unknown>[];
  readonly connects: () => number;
  readonly sleeps: () => number[];
  readonly type: (line: string) => void;
  readonly endInput: () => void;
  readonly interrupt: () => void;
  readonly drop: () => void;
  readonly dropOnNextSend: () => void;
}

export const testHost = (
  connect: ChatHost["connect"] = connectWebSocket,
): TestHost => {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const handlers = new Set<() => void>();
  const input = lineQueue();
  const sleeps: number[] = [];
  let connects = 0;
  let current: ChatSocket | undefined;
  let dropNext = false;
  let ids = 0;
  return {
    connect: async (url: string, token: string, events: SocketEvents) => {
      connects += 1;
      const socket = await connect(url, token, events);
      const wrapped: ChatSocket = {
        send: (text) => {
          sent.push(JSON.parse(text) as Record<string, unknown>);
          socket.send(text);
          if (dropNext && text.includes('"bot.prompt"')) {
            dropNext = false;
            socket.close();
          }
        },
        close: () => {
          socket.close();
        },
      };
      current = wrapped;
      return wrapped;
    },
    lines: input,
    onInterrupt: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    out: (text) => out.push(text),
    err: (line) => err.push(line),
    sleep: (millis) => {
      sleeps.push(millis);
      return new Promise((resolve) => setTimeout(resolve, 5));
    },
    random: () => 0.5,
    uuid: () => `cmd-${String((ids += 1))}`,
    stdout: () => out.join(""),
    stderr: () => err,
    everything: () => [...out, ...err].join("\n"),
    sent: () => sent,
    connects: () => connects,
    sleeps: () => sleeps,
    type: input.push,
    endInput: input.end,
    interrupt: () => {
      for (const handler of [...handlers]) handler();
    },
    drop: () => {
      current?.close();
    },
    dropOnNextSend: () => {
      dropNext = true;
    },
  };
};
