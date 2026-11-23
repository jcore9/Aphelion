/// <reference types="node" />
import process from "node:process";
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
