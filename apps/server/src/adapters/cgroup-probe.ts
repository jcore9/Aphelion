import { rmdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { checkTree, outcome, type ProbeRequest } from "./cgroup-check";

outcome(() => {
  rmdirSync(process.cwd());
});
for await (const line of createInterface({ input: process.stdin })) {
  const allowed = checkTree(JSON.parse(line) as ProbeRequest);
  process.stdout.write(`${JSON.stringify({ allowed })}\n`);
}
setInterval(() => undefined, 60_000);
