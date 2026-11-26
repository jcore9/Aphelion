import { readFile } from "node:fs/promises";
import { sessionRef } from "@aphelion/plugin-sdk";
import { describe, expect, it } from "vitest";
import { claudeCodeVersion, claudeEnv, queryOptions } from "./options.ts";

const deny = () =>
  Promise.resolve({ behavior: "deny" as const, message: "denied" });

const build = (resume: string | null = null) =>
  queryOptions({
    folder: "/var/lib/aphelion-bots/bot-1",
    resume: resume === null ? null : sessionRef.parse(resume),
    env: { HOME: "/var/lib/aphelion-bots" },
    canUseTool: deny,
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
      "TodoWrite",
    ]);
    expect(options.disallowedTools).toEqual(["WebFetch", "WebSearch", "Agent"]);
  });

  it("never sets an option that approves a tool without asking", () => {
    const options = build("4f1e2d3c-0000-4000-8000-000000000001");
    expect(options).not.toHaveProperty("allowedTools");
    expect(options).not.toHaveProperty("allowDangerouslySkipPermissions");
    expect(options).not.toHaveProperty("permissionPrompts");
    expect(options).not.toHaveProperty("settings");
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
