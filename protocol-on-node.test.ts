import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

test("the protocol package loads and parses a frame in plain Node", () => {
  const script = `
    const { parseClientFrame } = await import("./packages/protocol/src/index.ts");
    const parsed = parseClientFrame('{"v":1,"type":"resume","cursor":null}');
    console.log(JSON.stringify({ bun: process.versions.bun ?? null, parsed }));
  `;
  const output = execFileSync(
    realNode(),
    ["--input-type=module", "--no-warnings", "-e", script],
    { cwd: import.meta.dirname, encoding: "utf8" },
  );
  expect(JSON.parse(output)).toEqual({
    bun: null,
    parsed: { ok: true, frame: { v: 1, type: "resume", cursor: null } },
  });
});
