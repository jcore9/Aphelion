import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";

function realNode(): string {
  const bun = realpathSync(process.execPath);
  const found = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "node"))
    .find((path) => existsSync(path) && realpathSync(path) !== bun);
  if (!found) throw new Error("no Node.js on PATH apart from Bun's shim");
  return found;
}

function docsExample(): string {
  const page = readFileSync(
    join(import.meta.dirname, "docs/reference/plugin-manifest.md"),
    "utf8",
  );
  const block = /^## Example\n[^]*?^```json\n([^]*?)^```$/m.exec(page)?.[1];
  if (!block) throw new Error("plugin-manifest.md has lost its example");
  return block;
}

test("the plugin SDK loads in plain Node and accepts the docs' example manifest", () => {
  const script = `
    const { parsePluginManifest } = await import("./packages/plugin-sdk/src/index.ts");
    const manifest = JSON.parse(process.argv[1]);
    const results = [manifest, { ...manifest, api: "^99.0.0" }].map(parsePluginManifest);
    console.log(JSON.stringify({ bun: process.versions.bun ?? null, ok: results.map((r) => r.ok) }));
  `;
  const output = execFileSync(
    realNode(),
    ["--input-type=module", "--no-warnings", "-e", script, docsExample()],
    { cwd: import.meta.dirname, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({ bun: null, ok: [true, false] });
});
