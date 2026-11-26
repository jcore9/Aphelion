/// <reference types="node" />
import process from "node:process";
import { runAdapter, type RunAdapterOptions } from "./adapter-runtime.ts";
import type { BotAdapter } from "./adapter.ts";
import { readLines } from "./lines.ts";
import type { ServerPlugin } from "./plugin.ts";
import { runPlugin } from "./runtime.ts";

const log = (message: string) => {
  process.stderr.write(`${message.replaceAll(/\r?\n/g, " ")}\n`);
};

const write = (line: string) =>
  new Promise<void>((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const exit = (code: number) => {
  process.stderr.write("", () => process.exit(code));
};

/**
 * Runs a plugin on standard input and output, and exits the process when the plugin stops, with code 0, or 1 after an error.
 * It drops a line from the host that is longer than 1 MiB, and logs that it did.
 */
export function main(plugin: ServerPlugin): void {
  const input = readLines(process.stdin, () => {
    log("the host sent a line longer than 1 MiB, so the plugin dropped it");
  });
  runPlugin(plugin, { input, write, log }).then(
    () => {
      exit(0);
    },
    () => {
      exit(1);
    },
  );
}

/**
 * Runs a bot adapter on standard input and output, and exits the process when the adapter stops, with code 0, or 1 after an error.
 * It drops a line from the bot runner that is longer than 1 MiB, and logs that it did.
 */
export function mainAdapter(
  adapter: BotAdapter,
  options?: RunAdapterOptions,
): void {
  const input = readLines(process.stdin, () => {
    log(
      "the bot runner sent a line longer than 1 MiB, so the adapter dropped it",
    );
  });
  runAdapter(adapter, { input, write, log }, options).then(
    () => {
      exit(0);
    },
    () => {
      exit(1);
    },
  );
}

export type { RunAdapterOptions } from "./adapter-runtime.ts";
