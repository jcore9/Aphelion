import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeAdapter } from "../packages/claude-adapter/src/adapter.ts";
import { realpathOrMissing } from "../packages/claude-adapter/src/files.ts";
import { recordingClaude } from "../packages/claude-adapter/src/record.ts";
import { folderRule } from "../packages/plugin-sdk/src/folder-rule.ts";
import { checkStream, runTurn } from "../packages/plugin-sdk/src/testing.ts";

const usage = `usage: bun scripts/record-claude-stream.ts [--name tool-turn] [--prompt "..."]

Runs one real Claude turn through the adapter and writes the SDK's messages to
packages/claude-adapter/fixtures/<name>.jsonl. It needs Claude Code 2.1.330 at
/usr/local/bin/claude, signed in for the user who runs the script.`;

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "tool-turn" },
    prompt: {
      type: "string",
      default:
        "Create a file named hello.txt that contains the word hello, then read it back and tell me what it says.",
    },
    help: { type: "boolean", default: false },
  },
});

if (values.help || !/^[a-z0-9-]{1,64}$/.test(values.name)) {
  console.error(usage);
  process.exit(values.help ? 0 : 1);
}

const folder = await realpath(
  await mkdtemp(join(tmpdir(), "aphelion-claude-")),
);
const rule = folderRule(realpathOrMissing);

const messages: unknown[] = [];
const adapter = claudeAdapter({
  query: recordingClaude((message) => {
    messages.push(message);
  }),
  env: process.env,
  rule,
});

const run = await runTurn(adapter, {
  decider: rule,
  folder,
  text: values.prompt,
});
await rm(folder, { recursive: true, force: true });

for (const { event } of run.events) console.log(JSON.stringify(event));
for (const line of run.logs) console.error(line);

const ended = run.events.findLast(({ event }) => event.type === "turn.end");
const violations = checkStream(run.events);
if (violations.length > 0) {
  console.error(
    `checkStream found ${String(violations.length)} broken rules, so no fixture was written.`,
  );
  process.exit(1);
}
if (ended?.event.type !== "turn.end" || ended.event.reason !== "completed") {
  console.error("The turn didn't complete, so no fixture was written.");
  process.exit(1);
}

const scrub = (line: string) =>
  line.replaceAll(folder, "/work").replaceAll(homedir(), "/home/bot");

const fixtures = new URL(
  "../packages/claude-adapter/fixtures/",
  import.meta.url,
);
await mkdir(fixtures, { recursive: true });
const file = new URL(`${values.name}.jsonl`, fixtures);
await writeFile(
  file,
  messages.map((message) => scrub(JSON.stringify(message))).join("\n") + "\n",
);
console.log(
  `Wrote ${String(messages.length)} SDK messages to ${file.pathname}.`,
);
