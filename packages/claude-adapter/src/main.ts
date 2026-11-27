import { query } from "@anthropic-ai/claude-agent-sdk";
import { folderRule } from "@aphelion/plugin-sdk";
import { mainAdapter } from "@aphelion/plugin-sdk/stdio";
import { claudeAdapter } from "./adapter.ts";
import { realpathOrMissing } from "./files.ts";

const rule = folderRule(realpathOrMissing);

mainAdapter(claudeAdapter({ query, env: process.env, rule }), {
  decider: rule,
});
