import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { version } from "../version";
import { run } from "./testing";

const canary = "aph_dev_0123456789abcdef_secret";
const hint = "Run aphelion --help to see the commands.";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "aphelion-usage-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const usageErrors: readonly (readonly string[])[] = [
  ["--nope"],
  ["--nope", canary],
  [`--${canary}`],
  [`--nope=${canary}`],
  ["-x"],
  [`-${canary}`],
  ["device", "add", `-${canary}`],
  ["-vault"],
  ["-hv"],
  ["device", "list", "-hx"],
  ["--no-headless"],
  ["--no-headless", canary],
  [canary],
  ["device", canary],
  ["device"],
  ["device", "list", canary],
  ["device", "add"],
  ["device", "add", "x", canary],
  ["device", "add", ` ${canary}`],
  ["device", "add", "x", "--days", canary],
  ["device", "add", "x", "--days", "0"],
  ["device", "add", "x", "--days", canary, "--days", canary],
  ["device", "revoke", canary],
  ["device", "revoke", "0123456789abcdef", canary],
  ["device", "list", "--state-dir"],
  ["device", "list", "--state-dir", "--nope"],
  ["device", "list", "--state-dir", canary, "--state-dir", canary],
  ["device", "list", "--plugins-dir", canary],
  ["plugin", "install", "x", "--plugins-dir", canary],
  ["plugin", "enable", "x", "--plugins-dir", canary],
  ["plugin", "enable", canary, "--approve", canary, "--approve", canary],
  ["restore", "finish", canary],
  ["tool", "install", canary],
  ["tool", "update", canary],
  ["tool", "update", "claude", canary],
  ["tool", "update", "--tools-dir", canary],
  ["tool", "check", canary],
  ["tool", "list", "--tools-dir", canary],
  ["--headless", "--plugin-runner-fds", canary],
  ["--headless", "--bot-runner-fds", canary],
  ["--headless", "--plugin-runner-fds", "3,4", "--bot-runner-fds", "4,5"],
  ["--headless", "--plugin-dev", canary],
  ["--headless", "--days", canary],
  ["--headless", "--state-dir", ""],
];

describe("a usage error", () => {
  test.each(usageErrors)(
    "%j exits 2, writes only to stderr and never echoes the input",
    async (...argv) => {
      const { code, out, err } = await run(argv);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err).toHaveLength(2);
      expect(err[0]).toMatch(/^aphelion: /);
      expect(err[1]).toBe(hint);
      expect(err.join("\n")).not.toContain(canary);
      expect(err.join("\n")).not.toContain("aph_dev_");
    },
  );
});

describe("an empty value", () => {
  test.each([
    ["config", "check", "--compose", ""],
    ["config", "check", "--config-dir", ""],
    ["device", "list", "--state-dir="],
    ["plugin", "install", "/x", "--approve", ""],
    ["plugin", "install", "/x", "--plugins-dir", ""],
    ["tool", "list", "--tools-dir", ""],
    ["tool", "update", "--tools-dir", ""],
    ["--headless", "--plugin-dev", ""],
  ])("%j is refused", async (...argv) => {
    const { code, out, err } = await run(argv);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err[0]).toMatch(/^aphelion: --[a-z-]+ can't be empty$/);
  });

  test("a value is accepted", async () => {
    expect((await run(["device", "list", "--state-dir", stateDir])).code).toBe(
      0,
    );
  });
});

describe("--version and --help", () => {
  test.each([["--version"], ["-v"]])(
    "%s prints one line on standard output and exits 0",
    async (flag) => {
      expect(await run([flag])).toEqual({
        code: 0,
        out: [`aphelion ${version}`],
        err: [],
      });
    },
  );

  test.each([
    [[]],
    [["--help"]],
    [["-h"]],
    [["device", "add", "x", "--help", "--unknown"]],
  ])("%j prints help on standard output and exits 0", async (argv) => {
    const { code, out, err } = await run(argv);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("aphelion");
    expect(err).toEqual([]);
  });
});

describe("device add", () => {
  test("prints only the token on standard output", async () => {
    const { code, out, err } = await run([
      "device",
      "add",
      "laptop",
      "--state-dir",
      stateDir,
    ]);
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^aph_dev_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(err.join("\n")).not.toContain(out[0] ?? "");
  });
});
