import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatIssue } from "./issues";
import {
  checkConfigPermissions,
  checkStatePermissions,
  type Lstat,
  type Owner,
} from "./permissions";

const files = [
  "bots.yaml",
  "policy.yaml",
  "routines.yaml",
  "connectors.yaml",
  "server.yaml",
];
const me: Owner = {
  uid: process.getuid?.() ?? -1,
  gid: process.getgid?.() ?? -1,
};

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-perms-"));
  dir = join(root, "aphelion");
  await mkdir(dir, { mode: 0o750 });
  await chmod(dir, 0o750);
  for (const file of files) {
    await writeFile(join(dir, file), "version: 1\n", { mode: 0o640 });
    await chmod(join(dir, file), 0o640);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function check(owner: Owner = me, stat?: Lstat): Promise<string[]> {
  return (await checkConfigPermissions(dir, owner, stat)).map(formatIssue);
}

test("accepts a 0750 directory with 0640 files owned by the server", async () => {
  expect(await check()).toEqual([]);
});

test("accepts files at 0644, the mode git checks out", async () => {
  await chmod(join(dir, "bots.yaml"), 0o644);
  expect(await check()).toEqual([]);
});

test.each([
  [0o755, "0755"],
  [0o770, "0770"],
  [0o777, "0777"],
])("refuses a directory at mode %o", async (mode, shown) => {
  await chmod(dir, mode);
  expect(await check()).toEqual([
    `${dir}: has mode ${shown}, which is looser than 0750`,
  ]);
});

test("refuses a config file that group or others can write", async () => {
  await chmod(join(dir, "policy.yaml"), 0o664);
  expect(await check()).toEqual([
    `${join(dir, "policy.yaml")}: has mode 0664, which is looser than 0644`,
  ]);
});

test("refuses a config file that is a symlink", async () => {
  await rm(join(dir, "policy.yaml"));
  await writeFile(join(root, "elsewhere.yaml"), "version: 1\n");
  await symlink(join(root, "elsewhere.yaml"), join(dir, "policy.yaml"));
  expect(await check()).toEqual([
    `${join(dir, "policy.yaml")}: must be a regular file, not a symlink`,
  ]);
});

test("refuses a missing config file", async () => {
  await rm(join(dir, "routines.yaml"));
  expect(await check()).toEqual([`${join(dir, "routines.yaml")}: is missing`]);
});

test("refuses paths owned by another user or group", async () => {
  const otherDir: Lstat = async (path) => {
    const stat = await lstat(path);
    return path === dir ? { mode: stat.mode, uid: 4242, gid: 4343 } : stat;
  };
  expect(await check(me, otherDir)).toEqual([
    `${dir}: is owned by uid 4242, not the server's uid ${String(me.uid)}`,
    `${dir}: has group gid 4343, not the server's gid ${String(me.gid)}`,
  ]);
});

describe("the state folder", () => {
  const state = () => join(root, "state");

  test("accepts a 0700 folder owned by the server", async () => {
    await mkdir(state(), { mode: 0o700 });
    await chmod(state(), 0o700);
    expect(await checkStatePermissions(state(), me)).toEqual([]);
  });

  test("refuses a folder that group or others can enter", async () => {
    await mkdir(state(), { mode: 0o750 });
    await chmod(state(), 0o750);
    expect((await checkStatePermissions(state(), me)).map(formatIssue)).toEqual(
      [`${state()}: has mode 0750, which is looser than 0700`],
    );
  });

  test("refuses a missing folder, a file and the wrong owner", async () => {
    expect((await checkStatePermissions(state(), me)).map(formatIssue)).toEqual(
      [`${state()}: is missing`],
    );
    await writeFile(state(), "");
    expect((await checkStatePermissions(state(), me)).map(formatIssue)).toEqual(
      [`${state()}: must be a directory`],
    );
    await rm(state());
    await mkdir(state(), { mode: 0o700 });
    await chmod(state(), 0o700);
    const other = { uid: me.uid + 1, gid: me.gid };
    expect(
      (await checkStatePermissions(state(), other)).map(formatIssue),
    ).toEqual([
      `${state()}: is owned by uid ${String(me.uid)}, not the server's uid ${String(other.uid)}`,
    ]);
  });
});
