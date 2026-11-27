import { readFile } from "node:fs/promises";
import { parsePluginManifest } from "@aphelion/plugin-sdk";
import { describe, expect, it } from "vitest";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

describe("the claude-adapter package", () => {
  it("declares a bot adapter for the claude provider", async () => {
    const parsed = parsePluginManifest(
      await readJson("../aphelion-plugin.json"),
    );
    expect(parsed.ok && parsed.manifest.contributes.botAdapter).toEqual({
      provider: "claude",
    });
    expect(parsed.ok && parsed.manifest.server?.entry).toBe("adapter.js");
  });

  it("pins the Agent SDK to one exact version", async () => {
    const pkg = await readJson("../package.json");
    expect(pkg).toMatchObject({
      dependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.330" },
    });
  });
});
