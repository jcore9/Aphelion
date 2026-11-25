import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const freeRunners = new Set([
  "ubuntu-latest",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
]);

const workflows = join(import.meta.dirname, ".github/workflows");

function runnersIn(text: string): string[] {
  return [...text.matchAll(/^\s*runs-on:\s*(.+?)\s*$/gm)].flatMap((match) =>
    match.slice(1).map((value) => value.replace(/^(["'])(.*)\1$/, "$2")),
  );
}

test("every workflow job runs on a free standard GitHub-hosted runner", () => {
  const found = readdirSync(workflows)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) =>
      runnersIn(readFileSync(join(workflows, name), "utf8")).map((runner) => ({
        workflow: name,
        runner,
      })),
    );
  expect(found.length).toBeGreaterThan(0);
  expect(found.filter(({ runner }) => !freeRunners.has(runner))).toEqual([]);
});

test("the runner check rejects larger, self-hosted and computed runners and accepts standard ones", () => {
  const jobs = [
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-latest",
    "  b:",
    '    runs-on: "ubuntu-24.04-arm"',
    "  c:",
    "    runs-on: ubuntu-24.04-arm-16core",
    "  d:",
    "    runs-on: [self-hosted, linux]",
    "  e:",
    "    runs-on: ${{ matrix.os }}",
  ].join("\n");
  expect(runnersIn(jobs).filter((runner) => !freeRunners.has(runner))).toEqual([
    "ubuntu-24.04-arm-16core",
    "[self-hosted, linux]",
    "${{ matrix.os }}",
  ]);
});
