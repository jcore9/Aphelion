import type { CanUseTool, Options } from "@anthropic-ai/claude-agent-sdk";
import type { SessionRef } from "@aphelion/plugin-sdk";

export const claudeExecutable = "/usr/local/bin/claude";

export const claudeCodeVersion = "2.1.330";

export const enabledTools = [
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Bash",
  "TodoWrite",
] as const;

export const disabledTools = ["WebFetch", "WebSearch", "Agent"] as const;

const passedThrough = [
  "HOME",
  "PATH",
  "LANG",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const;

const fixed = {
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
} as const;

export type ParentEnv = Readonly<Record<string, string | undefined>>;

export function claudeEnv(parent: ParentEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of passedThrough) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...fixed };
}

export interface QueryOptionsInput {
  readonly folder: string;
  readonly resume: SessionRef | null;
  readonly env: Readonly<Record<string, string>>;
  readonly canUseTool: CanUseTool;
  readonly stderr: (data: string) => void;
  readonly abortController: AbortController;
  readonly hooks?: Options["hooks"];
}

export function queryOptions(input: QueryOptionsInput): Options {
  return {
    pathToClaudeCodeExecutable: claudeExecutable,
    executable: "bun",
    cwd: input.folder,
    permissionMode: "default",
    canUseTool: input.canUseTool,
    tools: [...enabledTools],
    disallowedTools: [...disabledTools],
    settingSources: [],
    includePartialMessages: true,
    env: { ...input.env },
    stderr: input.stderr,
    abortController: input.abortController,
    ...(input.resume === null ? {} : { resume: input.resume }),
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  };
}
