import process from "node:process";
import { createInterface } from "node:readline";

const build = "build-1";
process.stderr.write(
  `dev plugin ${build} started as uid ${String(process.getuid())}\n`,
);

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`,
    );
  } else if (message.method === "shutdown") {
    process.exit(0);
  }
}
