import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { expect, test, vi } from "vitest";

const NODE_START_BUDGET_MS = 60_000;
vi.setConfig({ testTimeout: NODE_START_BUDGET_MS });

function realNode(): string {
  const bun = realpathSync(process.execPath);
  const found = (process.env["PATH"] ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "node"))
    .find((path) => existsSync(path) && realpathSync(path) !== bun);
  if (!found) throw new Error("no Node.js on PATH apart from Bun's shim");
  return found;
}

function runOnNode(script: string, ...args: string[]): unknown {
  return runOnNodeIn(import.meta.dirname, script, ...args);
}

function runOnNodeIn(cwd: string, script: string, ...args: string[]): unknown {
  const output = execFileSync(
    realNode(),
    ["--input-type=module", "--no-warnings", "-e", script, ...args],
    { cwd, encoding: "utf8", timeout: NODE_START_BUDGET_MS },
  );
  return JSON.parse(output);
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

test("the protocol package loads and parses a frame in plain Node", () => {
  const script = `
    const { parseClientFrame } = await import("./packages/protocol/src/index.ts");
    const parsed = parseClientFrame('{"v":1,"type":"resume","cursor":null}');
    console.log(JSON.stringify({ bun: process.versions.bun ?? null, parsed }));
  `;
  expect(runOnNode(script)).toEqual({
    bun: null,
    parsed: { ok: true, frame: { v: 1, type: "resume", cursor: null } },
  });
});

test("the protocol package exports its frame JSON Schemas to plain Node", () => {
  const script = `
    const schemas = [];
    for (const file of ["client-frame.schema.json", "server-frame.schema.json"]) {
      const { default: schema } = await import("@aphelion/protocol/" + file, { with: { type: "json" } });
      schemas.push({ $schema: schema.$schema, title: schema.title });
    }
    console.log(JSON.stringify(schemas));
  `;
  expect(
    runOnNodeIn(join(import.meta.dirname, "packages/protocol"), script),
  ).toEqual([
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "ClientFrame",
    },
    {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "ServerFrame",
    },
  ]);
});

test("the plugin SDK loads in plain Node and accepts the docs' example manifest", () => {
  const script = `
    const { parsePluginManifest } = await import("./packages/plugin-sdk/src/index.ts");
    const manifest = JSON.parse(process.argv[1]);
    const results = [manifest, { ...manifest, api: "^99.0.0" }].map(parsePluginManifest);
    console.log(JSON.stringify({ bun: process.versions.bun ?? null, ok: results.map((r) => r.ok) }));
  `;
  expect(runOnNode(script, docsExample())).toEqual({
    bun: null,
    ok: [true, false],
  });
});
