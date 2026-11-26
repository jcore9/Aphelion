import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFor, parseToolList, processors, toolNames } from "./list";

const shippedListFile = join(
  import.meta.dirname,
  "../../../../deploy/ai-tools.json",
);

const parsed = parseToolList(readFileSync(shippedListFile, "utf8"));

describe("deploy/ai-tools.json", () => {
  it("passes the schema", () => {
    expect(parsed.ok).toBe(true);
  });

  it("lists Claude Code, Codex, Grok Build and OpenCode with a build for each processor", () => {
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.list.tools.map(({ name }) => name).sort()).toEqual(
      [...toolNames].sort(),
    );
    for (const tool of parsed.list.tools) {
      for (const processor of processors) {
        expect(
          buildFor(tool, processor).kind,
          `${tool.name} ${processor}`,
        ).toBe("available");
      }
    }
  });

  it("downloads every build over https from a fixed version", () => {
    if (!parsed.ok) throw new Error(parsed.message);
    for (const { name, version, builds } of parsed.list.tools) {
      for (const build of Object.values(builds)) {
        if (build === undefined) continue;
        expect(build.url.startsWith("https://"), name).toBe(true);
        expect(build.url, name).toContain(version);
      }
    }
  });

  it("has an entry at the path the image links each tool name to, on each processor", () => {
    if (!parsed.ok) throw new Error(parsed.message);
    const dockerfile = readFileSync(
      join(import.meta.dirname, "../../../../deploy/Dockerfile"),
      "utf8",
    );
    const targetOf = (name: string, processor: string) => {
      const loop =
        /for tool in ([a-z ]+); do ln -s "\/opt\/aphelion\/tools\/\$tool\/current\/([^"]+)"/.exec(
          dockerfile,
        );
      if (loop?.[1]?.split(" ").includes(name)) {
        return loop[2]?.replaceAll("$tool", name);
      }
      return new RegExp(`ln -s "/opt/aphelion/tools/${name}/current/([^"]+)"`)
        .exec(dockerfile)?.[1]
        ?.replaceAll("$(uname -m)", processor);
    };
    for (const tool of parsed.list.tools) {
      for (const processor of processors) {
        const found = buildFor(tool, processor);
        if (found.kind === "unavailable") continue;
        expect(found.build.entry, `${tool.name} ${processor}`).toBe(
          targetOf(tool.name, processor),
        );
      }
    }
  });
});
