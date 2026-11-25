import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// Standard runners for public repositories, which GitHub runs free:
// https://docs.github.com/en/actions/reference/runners/github-hosted-runners
const freeRunners = new Set([
  "ubuntu-slim",
  "ubuntu-latest",
  "ubuntu-26.04",
  "ubuntu-24.04",
  "ubuntu-22.04",
  "ubuntu-26.04-arm",
  "ubuntu-24.04-arm",
  "ubuntu-22.04-arm",
  "windows-latest",
  "windows-2025",
  "windows-2025-vs2026",
  "windows-2022",
  "windows-11-arm",
  "windows-11-vs2026-arm",
  "macos-latest",
  "macos-26",
  "macos-15",
  "macos-26-intel",
  "macos-15-intel",
  "xcode-27",
]);

const workflows = join(import.meta.dirname, ".github/workflows");

const plainRunsOn = /^\s*runs-on:\s*(["']?)([\w.-]+)\1\s*(#.*)?$/;
const externalWorkflow =
  /^\s*(-\s*)?uses:\s*["']?[^"'\s.][^"'\s]*\/\.github\/workflows\//;

function problemsIn(text: string): string[] {
  return text.split("\n").flatMap((line) => {
    if (externalWorkflow.test(line)) return [line.trim()];
    if (!line.includes("runs-on")) return [];
    const runner = plainRunsOn.exec(line)?.[2];
    return runner !== undefined && freeRunners.has(runner) ? [] : [line.trim()];
  });
}

function workflowFiles(): string[] {
  return readdirSync(workflows).map((name) => join(workflows, name));
}

test("every workflow job runs on a free standard GitHub-hosted runner", () => {
  const files = workflowFiles();
  expect(files.some((file) => /runs-on/.test(readFileSync(file, "utf8")))).toBe(
    true,
  );
  expect(
    files.flatMap((file) =>
      problemsIn(readFileSync(file, "utf8")).map((line) => ({ file, line })),
    ),
  ).toEqual([]);
});

test("the runner check accepts only plain free labels and rejects anything it can't read", () => {
  const accepted = [
    "    runs-on: ubuntu-latest",
    '    runs-on: "ubuntu-24.04-arm"',
    "    runs-on: ubuntu-22.04 # standard",
    "    runs-on: macos-latest",
    "    runs-on: windows-11-arm",
    "      - uses: ./.github/workflows/local.yml",
    "      - uses: actions/checkout@v7",
  ];
  const rejected = [
    "    runs-on: ubuntu-24.04-arm-16core",
    "    runs-on: [self-hosted, linux]",
    "    runs-on: macos-latest-xlarge",
    "    runs-on: ${{ matrix.os }}",
    '    "runs-on": ubuntu-latest',
    "  a: { runs-on: ubuntu-latest }",
    "    runs-on:",
    "    uses: other-org/repo/.github/workflows/build.yml@v1",
  ];
  expect(problemsIn(accepted.join("\n"))).toEqual([]);
  expect(problemsIn(rejected.join("\n"))).toEqual(
    rejected.map((line) => line.trim()),
  );
});
