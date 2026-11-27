import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import type { ChatEnvironment } from "./command";
import { connectWebSocket } from "./socket";

const hiddenInput = () =>
  new Promise<string>((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: new Writable({
        write: (_chunk, _encoding, done) => {
          done();
        },
      }),
      terminal: true,
    });
    process.stderr.write("Device token: ");
    const finish = (answer: string) => {
      process.stderr.write("\n");
      resolve(answer.trim());
      rl.close();
    };
    rl.once("SIGINT", () => {
      finish("");
    });
    rl.once("close", () => {
      resolve("");
    });
    rl.question("", finish);
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
        return () => rl.off("SIGINT", handler);
      },
      out: (text) => process.stdout.write(text),
      err: (line) => process.stderr.write(`${line}\n`),
      sleep: (millis) =>
        new Promise((resolve) => {
          setTimeout(resolve, millis);
        }),
      random: Math.random,
      uuid: () => crypto.randomUUID(),
    },
    isTerminal: process.stdin.isTTY && process.stderr.isTTY,
    promptToken: hiddenInput,
    release: () => {
      reader?.close();
    },
  };
};
