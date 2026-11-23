import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openLocalStore } from "./local-store";
import { Secret } from "./secret";

describe("local secret store", () => {
  let directory: string;
  const name = "test/api-key";
  const identity = () => join(directory, "identity.agekey");

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aphelion-secrets-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function write(
    store: Awaited<ReturnType<typeof openLocalStore>>,
    value: string,
  ) {
    const secret = Secret.make(value);
    try {
      await store.write(name, secret);
    } finally {
      secret.wipe();
    }
  }

  it("encrypts entries, keeps the identity and replaces a value across opens", async () => {
    const first = await openLocalStore(directory);
    expect(await first.read(name)).toBeUndefined();
    await write(first, "a-local-canary");
    const entries = (await readdir(directory)).filter((entry) =>
      entry.endsWith(".age"),
    );
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined) throw new Error("Missing ciphertext");
    const path = join(directory, entry);
    const ciphertext = await readFile(path);
    expect(ciphertext.toString("utf8")).toMatch(/^age-encryption\.org\/v1\n/);
    expect(ciphertext.includes("a-local-canary")).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(identity())).mode & 0o777).toBe(0o600);

    const second = await openLocalStore(directory);
    const restored = await second.read(name);
    try {
      expect(restored?.reveal()).toBe("a-local-canary");
    } finally {
      restored?.wipe();
    }
    await write(second, "replacement-value");
    const replacement = await first.read(name);
    try {
      expect(replacement?.reveal()).toBe("replacement-value");
    } finally {
      replacement?.wipe();
    }
  });

  it.each(["\uFEFFleading-marker", "unpaired-\uD800-surrogate"])(
    "preserves the exact string %j across opens",
    async (value) => {
      await write(await openLocalStore(directory), value);
      const secret = await (await openLocalStore(directory)).read(name);
      try {
        expect(secret?.reveal()).toBe(value);
      } finally {
        secret?.wipe();
      }
    },
  );

  it("rejects a valid encrypted entry restored under another reference", async () => {
    const store = await openLocalStore(directory);
    const otherName = "test/other-key";
    const entryPath = (reference: string) =>
      join(
        directory,
        `${createHash("sha256").update(reference).digest("hex")}.age`,
      );
    await write(store, "restore-canary");

    await rename(entryPath(name), entryPath(otherName));
    await expect(store.read(otherName)).rejects.toThrow(
      "Invalid local secret entry",
    );

    await rename(entryPath(otherName), entryPath(name));
    const restored = await store.read(name);
    try {
      expect(restored?.reveal()).toBe("restore-canary");
    } finally {
      restored?.wipe();
    }
  });

  it("refuses unsafe permissions and refuses to replace a missing identity", async () => {
    await chmod(directory, 0o750);
    await expect(openLocalStore(directory)).rejects.toThrow(
      "Unsafe secrets store directory",
    );
    await chmod(directory, 0o700);
    const store = await openLocalStore(directory);
    await write(store, "a-local-canary");
    await chmod(identity(), 0o640);
    await expect(openLocalStore(directory)).rejects.toThrow(
      "Unsafe secrets store file",
    );
    await unlink(identity());
    await expect(openLocalStore(directory)).rejects.toThrow(
      "Secrets store identity is missing",
    );
    expect(await readdir(directory)).toHaveLength(1);
  });
});
