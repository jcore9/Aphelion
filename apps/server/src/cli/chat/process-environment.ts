import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { ChatEnvironment } from "./command";
import { connectWebSocket } from "./socket";

export const askForToken = (
  input: NodeJS.ReadableStream,
  write: (text: string) => void,
) =>
  new Promise<string | null>((resolve) => {
    const rl = createInterface({
      input,
      output: new Writable({
        write: (_chunk, _encoding, done) => {
          done();
        },
      }),
      terminal: true,
    });
    write("Device token: ");
    let answered = false;
    const finish = (answer: string | null) => {
      if (answered) return;
      answered = true;
      write("\n");
      resolve(answer === null ? null : answer.trim());
      rl.close();
    };
    rl.once("SIGINT", () => {
      finish(null);
    });
    rl.once("close", () => {
      finish(null);
    });
    rl.question("", finish);
  });

export const interruptFromProcess = (handler: () => void) => {
  const runtime = process.listeners("SIGINT");
  for (const listener of runtime) process.off("SIGINT", listener);
  process.on("SIGINT", handler);
  return () => {
    process.off("SIGINT", handler);
    for (const listener of runtime) process.on("SIGINT", listener);
  };
};

export const sleepUnlessAborted = (millis: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, millis);
    signal.addEventListener("abort", done);
  });

export const processEnvironment = (): ChatEnvironment => {
  let reader: Interface | undefined;
  const open = () =>
    (reader ??= createInterface({
      input: process.stdin,
      ...(process.stdin.isTTY ? { output: process.stdout } : {}),
      terminal: process.stdin.isTTY,
      prompt: "",
    }));
  return {
    host: {
      connect: connectWebSocket,
      lines: {
        [Symbol.asyncIterator]: () => open()[Symbol.asyncIterator](),
      },
      onInterrupt: (handler) => {
        const rl = open();
        rl.on("SIGINT", handler);
        const stopProcess = interruptFromProcess(handler);
        return () => {
          rl.off("SIGINT", handler);
          stopProcess();
        };
      },
      out: (text) => process.stdout.write(text),
      err: (line) => process.stderr.write(`${line}\n`),
      sleep: sleepUnlessAborted,
      random: Math.random,
      uuid: () => crypto.randomUUID(),
    },
    isTerminal: process.stdin.isTTY && process.stderr.isTTY,
    promptToken: () =>
      askForToken(process.stdin, (text) => process.stderr.write(text)),
    release: () => {
      reader?.close();
    },
  };
};
