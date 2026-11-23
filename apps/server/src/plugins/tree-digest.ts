import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";

export const maxTreeFiles = 1000;
export const maxTreeBytes = 64 * 1024 * 1024;

export class TreeRefused extends Data.TaggedError("TreeRefused")<{
  readonly reason: string;
}> {}

export const byteOrder = (a: string, b: string) =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

class Refusal extends Error {}

async function readRegular(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) {
      throw new Refusal(`${path} changed while it was read`);
    }
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function digestTree(root: string): Promise<string> {
  const pairs: [string, string][] = [];
  let bytes = 0;
  const walk = async (relative: string) => {
    for (const name of await readdir(join(root, relative))) {
      const path = relative === "" ? name : `${relative}/${name}`;
      const info = await lstat(join(root, path));
      if (info.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!info.isFile()) {
        throw new Refusal(`${path} isn't a regular file or a folder`);
      }
      if (pairs.length === maxTreeFiles) {
        throw new Refusal(`it has more than ${String(maxTreeFiles)} files`);
      }
      const tooBig = new Refusal("its files add up to more than 64 MiB");
      if (bytes + info.size > maxTreeBytes) throw tooBig;
      const content = await readRegular(join(root, path));
      bytes += content.length;
      if (bytes > maxTreeBytes) throw tooBig;
      pairs.push([path, createHash("sha256").update(content).digest("hex")]);
    }
  };
  await walk("");
  pairs.sort(([a], [b]) => byteOrder(a, b));
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}

export const filesDigest = (folder: string) =>
  Effect.tryPromise({
    try: () => digestTree(folder),
    catch: (error) =>
      new TreeRefused({
        reason:
          error instanceof Refusal
            ? error.message
            : `its files can't be read (${(error as NodeJS.ErrnoException).code ?? String(error)})`,
      }),
  });
