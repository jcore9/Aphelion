import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkTree, maxAllowed } from "./cgroup-check";

let root = "";
let tree = "";
let leaf = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aphelion-check-"));
  tree = join(root, "bots");
  leaf = join(tree, "work", "own");
  mkdirSync(leaf, { recursive: true });
  mkdirSync(join(tree, "system"));
  writeFileSync(join(leaf, "cgroup.procs"), "");
  mkdirSync(join(root, "run"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const request = () => ({
  tree,
  leaf,
  folder: join(root, "run"),
  fifos: [],
});

const vanish = (path: string) => {
  symlinkSync(join(root, "nowhere"), path);
};

describe("the cgroup probe's checks", () => {
  it("skips a sibling run's leaf that ends between the listing and the check", () => {
    mkdirSync(join(tree, "work", "ending"));
    vanish(join(tree, "work", "ending", "cgroup.procs"));
    vanish(join(tree, "work", "ended"));
    const allowed = checkTree(request());
    expect(allowed.some((entry) => entry.includes("ended"))).toBe(false);
    expect(
      allowed.some((entry) => entry.includes(join("ending", "cgroup.procs"))),
    ).toBe(false);
    expect(allowed).toContain(`mkdir ${leaf}: ok`);
  });

  it("fails when its own leaf is gone", () => {
    rmSync(leaf, { recursive: true });
    vanish(leaf);
    expect(checkTree(request())).toContain(`find ${leaf}: ENOENT`);
  });

  it("fails when a path outside the run leaves disappears", () => {
    vanish(join(tree, "system", "cgroup.procs"));
    expect(checkTree(request())).toContain(
      `find ${join(tree, "system", "cgroup.procs")}: ENOENT`,
    );
  });

  it("caps its answer", () => {
    for (let index = 0; index < maxAllowed + 10; index++) {
      mkdirSync(join(tree, "system", `extra-${String(index)}`));
    }
    expect(checkTree(request())).toHaveLength(maxAllowed);
  });
});
