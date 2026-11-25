import { readFileSync } from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { inheritedPipes, runChecks } from "./probe.mjs";

const checks = JSON.parse(readFileSync("checks.json", "utf8"));
const failures = [...(await runChecks(checks)), ...inheritedPipes()];
process.stderr.write(
  failures.length === 0
    ? "plugin probe passed\n"
    : `plugin probe failed: ${failures.join("; ")}\n`,
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
