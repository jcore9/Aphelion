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
import { Decrypter, Encrypter, identityToRecipient } from "age-encryption";
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

export type LocalStoreRefusalReason =
  | "The secrets store holds a plain-text key from before the host credential"
  | "The bootstrap key is not a valid age identity"
  | "The bootstrap key does not match this secrets store";

export class LocalStoreRefusal extends Error {
  override name = "LocalStoreRefusal";

  constructor(readonly reason: LocalStoreRefusalReason) {
    super(reason);
  }
}

async function recipientOf(key: Secret): Promise<string> {
  try {
    return await identityToRecipient(key.reveal());
  } catch {
    throw new LocalStoreRefusal(
      "The bootstrap key is not a valid age identity",
    );
  }
}

const entryFile = (name: string) =>
  `${createHash("sha256").update(name).digest("hex")}.age`;

async function decryptEntry(
  decrypter: Decrypter,
  encrypted: Uint8Array,
): Promise<z.infer<typeof entrySchema> | undefined> {
  try {
    const entry = entrySchema.safeParse(
      JSON.parse(await decrypter.decrypt(encrypted, "text")),
    );
    return entry.success ? entry.data : undefined;
  } catch {
    return undefined;
  }
}

async function checkRecipient(
  directory: string,
  uid: number,
  recipient: string,
  decrypter: Decrypter,
): Promise<void> {
  const path = join(directory, "recipient.pub");
  const mismatch = new LocalStoreRefusal(
    "The bootstrap key does not match this secrets store",
  );
  let recorded = await readPrivateFile(path, uid);
  if (!recorded) {
    const entries = (await readdir(directory)).filter((name) =>
      /^[0-9a-f]{64}\.age$/.test(name),
    );
    for (const name of entries) {
      const encrypted = await readPrivateFile(join(directory, name), uid);
      const entry = encrypted && (await decryptEntry(decrypter, encrypted));
      if (!entry || entryFile(entry.path) !== name) throw mismatch;
    }
    try {
      await publish(directory, path, `${recipient}\n`, link);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
    recorded = await readPrivateFile(path, uid);
  }
  if (recorded?.toString("utf8").trim() !== recipient) throw mismatch;
}

export async function openLocalStore(directory: string, key: Secret) {
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
  const legacy = await lstat(join(directory, "identity.agekey")).catch(
    (error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    },
  );
  if (legacy) {
    throw new LocalStoreRefusal(
      "The secrets store holds a plain-text key from before the host credential",
    );
  }
  const recipient = await recipientOf(key);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  const decrypter = new Decrypter();
  decrypter.addIdentity(key.reveal());
  await checkRecipient(directory, uid, recipient, decrypter);

  const entryPath = (name: string) => join(directory, entryFile(name));
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
