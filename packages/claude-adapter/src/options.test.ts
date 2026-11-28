import { readFile } from "node:fs/promises";
import { sessionRef } from "@aphelion/plugin-sdk";
import { describe, expect, it } from "vitest";
import { claudeCodeVersion, claudeEnv, queryOptions } from "./options.ts";

const deny = () =>
  Promise.resolve({ behavior: "deny" as const, message: "denied" });

const preToolUse = () => Promise.resolve({});

const build = (resume: string | null = null) =>
  queryOptions({
    folder: "/var/lib/aphelion-bots/bot-1",
    resume: resume === null ? null : sessionRef.parse(resume),
    env: { HOME: "/var/lib/aphelion-bots" },
    canUseTool: deny,
    preToolUse,
    stderr: () => undefined,
    abortController: new AbortController(),
  });

describe("claudeEnv", () => {
  it("passes only the allowed variables and adds the fixed ones", () => {
    expect(
      claudeEnv({
        HOME: "/var/lib/aphelion-bots",
        PATH: "/usr/local/bin:/usr/bin",
        LANG: "C.UTF-8",
        TZ: "UTC",
        TMPDIR: "/tmp",
        HTTPS_PROXY: "http://proxy:3128",
        no_proxy: "localhost",
        ANTHROPIC_API_KEY: "sk-ant-fake",
        ANTHROPIC_AUTH_TOKEN: "fake-token",
        CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
        CLAUDE_CONFIG_DIR: "/elsewhere",
        NODE_OPTIONS: "--require /tmp/evil.js",
        APHELION_SECRET: "fake",
      }),
    ).toEqual({
      HOME: "/var/lib/aphelion-bots",
      PATH: "/usr/local/bin:/usr/bin",
      LANG: "C.UTF-8",
      TZ: "UTC",
      TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy:3128",
      no_proxy: "localhost",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
  });

  it("passes ANTHROPIC_API_KEY only when told there is no working sign-in, and never the other tokens", () => {
    const parent = {
      HOME: "/var/lib/aphelion-bots",
      ANTHROPIC_API_KEY: "sk-ant-fake",
      ANTHROPIC_AUTH_TOKEN: "fake-token",
      CLAUDE_CODE_OAUTH_TOKEN: "fake-oauth",
    };
    expect(claudeEnv(parent, "none")).toEqual({
      HOME: "/var/lib/aphelion-bots",
      ANTHROPIC_API_KEY: "sk-ant-fake",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
    expect(claudeEnv(parent, "working")).toEqual(claudeEnv(parent));
    expect(claudeEnv(parent)).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claudeEnv({ HOME: "/h" }, "none")).not.toHaveProperty(
      "ANTHROPIC_API_KEY",
    );
  });

  it("leaves out a variable the parent doesn't have", () => {
    expect(claudeEnv({})).toEqual({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
  });

  it("keeps the fixed values when the parent sets them otherwise", () => {
    expect(
      claudeEnv({
        DISABLE_AUTOUPDATER: "0",
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0",
      }),
    ).toEqual({
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    });
  });
});

describe("queryOptions", () => {
  it("runs the pinned binary in the bot's folder in default mode with no settings files", () => {
    expect(build()).toMatchObject({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      cwd: "/var/lib/aphelion-bots/bot-1",
      permissionMode: "default",
      settingSources: [],
      includePartialMessages: true,
      env: { HOME: "/var/lib/aphelion-bots" },
    });
  });

  it("delivers every prompt as written, with no file mentions or slash commands", () => {
    expect(build().verbatimPrompts).toBe(true);
    expect(build("4f1e2d3c-0000-4000-8000-000000000001").verbatimPrompts).toBe(
      true,
    );
  });

  it("offers the file and shell tools and removes web and sub-agents", () => {
    const options = build();
    expect(options.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "NotebookEdit",
      "Glob",
      "Grep",
      "Bash",
    ]);
    expect(options.disallowedTools).toEqual([
      "WebFetch",
      "WebSearch",
      "Agent",
      "Skill",
    ]);
  });

  it("enables no skills", () => {
    expect(build().skills).toEqual([]);
  });

  it("turns off the account's claude.ai connectors, skills, plugins, memory, workflows, artifacts and session sharing", () => {
    expect(build().settings).toEqual({
      disableClaudeAiConnectors: true,
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
      disableBundledSkills: true,
      disableSkillShellExecution: true,
      autoMemoryEnabled: false,
      autoDreamEnabled: false,
      disableWorkflows: true,
      enableWorkflows: false,
      workflowKeywordTriggerEnabled: false,
      enableArtifact: false,
      crossSessionInbound: "refuse",
      autoUploadSessions: false,
    });
  });

  it("uses only the MCP servers the adapter passes, and passes none", () => {
    const options = build("4f1e2d3c-0000-4000-8000-000000000001");
    expect(options.strictMcpConfig).toBe(true);
    expect(options).not.toHaveProperty("mcpServers");
    expect(options).not.toHaveProperty("plugins");
  });

  it("runs the rule's hook before every tool call, and blocks the call if the hook fails", () => {
    expect(build().hooks).toEqual({
      PreToolUse: [{ hooks: [preToolUse], onFailure: "block" }],
    });
  });

  it("never sets an option that approves a tool without asking", () => {
    const options = build("4f1e2d3c-0000-4000-8000-000000000001");
    expect(options).not.toHaveProperty("allowedTools");
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options).not.toHaveProperty("permissionPrompts");
    expect(options.settings).not.toHaveProperty("permissions");
    expect(options.canUseTool).toBe(deny);
  });

  it("resumes the saved session only when there is one", () => {
    expect(build()).not.toHaveProperty("resume");
    expect(build("4f1e2d3c-0000-4000-8000-000000000001").resume).toBe(
      "4f1e2d3c-0000-4000-8000-000000000001",
    );
  });

  it("expects the Claude Code version that the pinned SDK was built for", async () => {
    const sdk: unknown = JSON.parse(
      await readFile(
        new URL(
          "../node_modules/@anthropic-ai/claude-agent-sdk/package.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(sdk).toMatchObject({ claudeCodeVersion });
  });
});
