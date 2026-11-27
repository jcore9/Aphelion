import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { realpathOrMissing } from "./files.ts";

let root = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "aphelion-files-")));
  await mkdir(join(root, "dir"));
  await writeFile(join(root, "dir", "file.txt"), "x");
  await symlink(join(root, "dir"), join(root, "link"));
  await symlink(join(root, "gone.txt"), join(root, "broken"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("realpathOrMissing", () => {
  it("resolves a path that exists, following links", async () => {
    expect(await realpathOrMissing(join(root, "dir", "file.txt"))).toBe(
      join(root, "dir", "file.txt"),
    );
    expect(await realpathOrMissing(join(root, "link", "file.txt"))).toBe(
      join(root, "dir", "file.txt"),
    );
  });

  it("resolves to undefined when nothing is at the path", async () => {
    expect(await realpathOrMissing(join(root, "new.txt"))).toBeUndefined();
    expect(
      await realpathOrMissing(join(root, "new", "deeper.txt")),
    ).toBeUndefined();
  });

  it("rejects for a broken link and for a path under a file", async () => {
    await expect(realpathOrMissing(join(root, "broken"))).rejects.toThrow();
    await expect(
      realpathOrMissing(join(root, "dir", "file.txt", "x")),
    ).rejects.toThrow();
  });
});
