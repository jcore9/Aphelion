import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newFolderVariable } from "../cgroups/protocol";

const launcher = new URL("./adapter-launcher.ts", import.meta.url).pathname;

let root = "";
let script = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aphelion-launcher-"));
  script = join(root, "print-cwd.js");
  writeFileSync(script, "process.stdout.write(process.cwd());\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const launch = (folder: string, fresh: boolean) => {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  if (fresh) env[newFolderVariable] = "1";
  const ran = Bun.spawnSync(
    [process.execPath, "--preload", launcher, script, "alpha", folder],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: ran.exitCode,
    stdout: ran.stdout.toString(),
    stderr: ran.stderr.toString(),
  };
};

describe("the adapter launcher", () => {
  it("creates a missing bot folder with its parents and enters an existing one", () => {
    const folder = join(root, "bots", "alpha");
    expect(launch(folder, false)).toMatchObject({ code: 0, stdout: folder });
    expect(launch(folder, false)).toMatchObject({ code: 0, stdout: folder });
  });

  it("creates a new folder only it can enter when asked for one, and refuses a folder that is already there", () => {
    const folder = join(root, "aphelion-probe-run");
    expect(launch(folder, true)).toMatchObject({ code: 0, stdout: folder });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const taken = join(root, "taken");
    mkdirSync(taken);
    expect(launch(taken, true)).toMatchObject({
      code: 1,
      stdout: "",
      stderr:
        "the adapter couldn't enter its bot's folder, so it didn't start\n",
    });
    writeFileSync(join(root, "file"), "");
    expect(launch(join(root, "file"), true).code).toBe(1);
  });
});
