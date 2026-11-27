import type { ChatHost, ChatSocket, SocketEvents } from "./session";
import { sleepUnlessAborted } from "./process-environment";
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
  readonly sleepSignals: () => AbortSignal[];
  readonly type: (line: string) => void;
  readonly endInput: () => void;
  readonly interrupt: () => void;
  readonly drop: () => void;
  readonly muteCurrent: () => void;
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
  const signals: AbortSignal[] = [];
  let connects = 0;
  let current: ChatSocket | undefined;
  let mute: () => void = () => undefined;
  let ids = 0;
  return {
    connect: async (url: string, token: string, events: SocketEvents) => {
      connects += 1;
      let muted = false;
      mute = () => {
        muted = true;
      };
      const socket = await connect(url, token, {
        message: (text) => {
          if (!muted) events.message(text);
        },
        close: events.close,
      });
      const wrapped: ChatSocket = {
        send: (text) => {
          sent.push(JSON.parse(text) as Record<string, unknown>);
          socket.send(text);
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
    sleep: (millis, signal) => {
      sleeps.push(millis);
      signals.push(signal);
      return sleepUnlessAborted(5, signal);
    },
    random: () => 0.5,
    uuid: () => `cmd-${String((ids += 1))}`,
    stdout: () => out.join(""),
    stderr: () => err,
    everything: () => [...out, ...err].join("\n"),
    sent: () => sent,
    connects: () => connects,
    sleeps: () => sleeps,
    sleepSignals: () => signals,
    type: input.push,
    endInput: input.end,
    interrupt: () => {
      for (const handler of [...handlers]) handler();
    },
    drop: () => {
      current?.close();
    },
    muteCurrent: () => {
      mute();
    },
  };
};
