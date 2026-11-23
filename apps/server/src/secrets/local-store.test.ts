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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalStoreRefusal, openLocalStore } from "./local-store";
import { Secret } from "./secret";

const newKey = async () =>
  Secret.make(await generateIdentity(), { label: "bootstrap key" });

describe("local secret store", () => {
  let directory: string;
  let key: Secret;
  const name = "test/api-key";
  const recipientFile = () => join(directory, "recipient.pub");
  const open = (withKey = key) => openLocalStore(directory, withKey);
  const mismatch = "The bootstrap key does not match this secrets store";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "aphelion-secrets-"));
    key = await newKey();
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

  it("encrypts entries with the given key, stores no identity and replaces a value across opens", async () => {
    const first = await open();
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
    expect((await readFile(recipientFile(), "utf8")).trim()).toBe(
      await identityToRecipient(key.reveal()),
    );
    expect((await stat(recipientFile())).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).sort()).toEqual(
      [entry, "recipient.pub"].sort(),
    );
    for (const file of await readdir(directory)) {
      expect(
        (await readFile(join(directory, file))).includes(key.reveal()),
      ).toBe(false);
    }

    const second = await open();
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
      await write(await open(), value);
      const secret = await (await open()).read(name);
      try {
        expect(secret?.reveal()).toBe(value);
      } finally {
        secret?.wipe();
      }
    },
  );

  it("rejects a valid encrypted entry restored under another reference", async () => {
    const store = await open();
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

  it("refuses another key, before and after recipient.pub is recorded", async () => {
    await write(await open(), "a-local-canary");
    await expect(open(await newKey())).rejects.toThrow(mismatch);

    await unlink(recipientFile());
    await expect(open(await newKey())).rejects.toThrow(mismatch);
    await expect(readFile(recipientFile())).rejects.toThrow("ENOENT");

    const restored = await (await open()).read(name);
    try {
      expect(restored?.reveal()).toBe("a-local-canary");
    } finally {
      restored?.wipe();
    }
    expect(await readdir(directory)).toContain("recipient.pub");
  });

  it("refuses a plain-text identity left from before the host credential", async () => {
    await write(await open(), "a-local-canary");
    await writeFile(join(directory, "identity.agekey"), key.reveal(), {
      mode: 0o600,
    });
    await expect(open()).rejects.toThrow(
      new LocalStoreRefusal(
        "The secrets store holds a plain-text key from before the host credential",
      ),
    );
    await unlink(join(directory, "identity.agekey"));
    await expect(open()).resolves.toBeDefined();
  });

  it("refuses an invalid key without repeating it", async () => {
    const invalid = "AGE-SECRET-KEY-1NOTAREALKEYBUTCLOSEENOUGHTOREACHBECH32";
    const refusal = await open(Secret.make(invalid)).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(LocalStoreRefusal);
    expect(String(refusal)).not.toContain(invalid);
    expect((refusal as LocalStoreRefusal).reason).toBe(
      "The bootstrap key is not a valid age identity",
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it("refuses unsafe permissions", async () => {
    await chmod(directory, 0o750);
    await expect(open()).rejects.toThrow("Unsafe secrets store directory");
    await chmod(directory, 0o700);
    await write(await open(), "a-local-canary");
    await chmod(recipientFile(), 0o640);
    await expect(open()).rejects.toThrow("Unsafe secrets store file");
    await chmod(recipientFile(), 0o600);
    await expect(open()).resolves.toBeDefined();
  });
});
