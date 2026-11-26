import { query } from "@anthropic-ai/claude-agent-sdk";
import { mainAdapter } from "@aphelion/plugin-sdk/stdio";
import { claudeAdapter } from "./adapter.ts";

mainAdapter(claudeAdapter({ query, env: process.env }));
