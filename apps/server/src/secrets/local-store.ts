import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import {
  Decrypter,
  Encrypter,
  generateIdentity,
  identityToRecipient,
} from "age-encryption";
import { z } from "zod";
import { Secret } from "./secret";

const entrySchema = z.strictObject({
  version: z.literal(1),
  path: z.string(),
  value: z.string(),
});

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publish(
  directory: string,
  destination: string,
  data: string | Uint8Array,
  install: typeof rename,
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await install(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

async function readPrivateFile(
  path: string,
  uid: number,
): Promise<Buffer | undefined> {
  const info = await lstat(path).catch((error: unknown) => {
    if (!hasCode(error, "ENOENT")) throw error;
    return undefined;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.uid !== uid || (info.mode & 0o7777) !== 0o600) {
    throw new Error("Unsafe secrets store file");
  }
  return await readFile(path);
}

async function loadIdentity(directory: string, uid: number): Promise<string> {
  const path = join(directory, "identity.agekey");
  const existing = await readPrivateFile(path, uid);
  if (existing) return existing.toString("utf8");

  if ((await readdir(directory)).some((name) => name.endsWith(".age"))) {
    const identity = await readPrivateFile(path, uid);
    if (identity) return identity.toString("utf8");
    throw new Error("Secrets store identity is missing");
  }

  try {
    // The first opener installs the identity without replacing another opener's key.
    await publish(directory, path, await generateIdentity(), link);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const identity = await readPrivateFile(path, uid);
  if (!identity) throw new Error("Secrets store identity is missing");
  return identity.toString("utf8");
}

export async function openLocalStore(directory: string) {
  const uid = process.getuid?.();
  const info = await lstat(directory);
  if (
    uid === undefined ||
    !info.isDirectory() ||
    info.uid !== uid ||
    (info.mode & 0o7777) !== 0o700
  ) {
    throw new Error("Unsafe secrets store directory");
  }
  const identity = await loadIdentity(directory, uid);
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(identity));
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);

  const entryPath = (name: string) =>
    join(directory, `${createHash("sha256").update(name).digest("hex")}.age`);
  return {
    async read(name: string): Promise<Secret | undefined> {
      const encrypted = await readPrivateFile(entryPath(name), uid);
      if (!encrypted) return undefined;
      const plaintext: unknown = JSON.parse(
        await decrypter.decrypt(encrypted, "text"),
      );
      const entry = entrySchema.safeParse(plaintext);
      if (!entry.success || entry.data.path !== name) {
        throw new Error("Invalid local secret entry");
      }
      return Secret.make(entry.data.value);
    },
    async write(name: string, value: Secret): Promise<void> {
      const entry = {
        version: 1,
        path: name,
        value: value.reveal(),
      } satisfies z.infer<typeof entrySchema>;
      const encrypted = await encrypter.encrypt(JSON.stringify(entry));
      await publish(directory, entryPath(name), encrypted, rename);
    },
  };
}
