import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export type TarEntry =
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "file"; readonly path: string; readonly data: Uint8Array };

export type TarResult =
  | { readonly ok: true; readonly entries: readonly TarEntry[] }
  | { readonly ok: false; readonly reason: string };

export const tarLimits = {
  entries: 1000,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  segments: 32,
};

const block = 512;
const ustarMagic = "ustar\u000000";
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Refusal extends Error {}

const refuse = (reason: string): never => {
  throw new Refusal(reason);
};

const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0);

function field(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  if (end !== -1 && !isZero(bytes.subarray(end))) {
    refuse("a header field holds bytes after its end");
  }
  try {
    return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end));
  } catch {
    return refuse("a name isn't valid UTF-8");
  }
}

function octal(header: Uint8Array, offset: number, length: number): number {
  const text = Buffer.from(header.subarray(offset, offset + length))
    .toString("latin1")
    .replace(/^ +|[ \0]+$/g, "");
  if (!/^[0-7]{1,11}$/.test(text)) refuse("a header holds a bad number");
  return parseInt(text, 8);
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  header.forEach((byte, index) => {
    sum += index >= 148 && index < 156 ? 32 : byte;
  });
  return sum;
}

function entryPath(raw: string, folder: boolean): string | undefined {
  let path = raw.startsWith("./") ? raw.slice(2) : raw;
  if (folder && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "" && raw.startsWith("./")) return undefined;
  if (/[\\\p{Cc}]/u.test(path)) {
    refuse(`${JSON.stringify(raw)} holds a backslash or a control character`);
  }
  const segments = path.split("/");
  if (segments.length > tarLimits.segments) {
    refuse(`${JSON.stringify(raw)} is nested too deep`);
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      refuse(`${JSON.stringify(raw)} isn't a plain relative path`);
    }
  }
  return path;
}

function parentsOf(path: string): string[] {
  const segments = path.split("/");
  return segments
    .slice(1)
    .map((_, index) => segments.slice(0, index + 1).join("/"));
}

function read(archive: Uint8Array): TarEntry[] {
  if (archive.length % block !== 0) refuse("its length isn't whole blocks");
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  const files = new Set<string>();
  const folders = new Set<string>();
  let total = 0;
  let offset = 0;
  while (offset + block <= archive.length) {
    const header = archive.subarray(offset, offset + block);
    if (isZero(header)) {
      if (!isZero(archive.subarray(offset))) {
        refuse("it holds data after its end marker");
      }
      if (archive.length - offset < 2 * block) {
        refuse("its end marker is cut short");
      }
      return entries;
    }
    if (octal(header, 148, 8) !== checksum(header)) {
      refuse("a header's checksum is wrong");
    }
    if (String.fromCharCode(...header.subarray(257, 265)) !== ustarMagic) {
      refuse("it isn't a POSIX ustar archive");
    }
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "\u0000" && type !== "5") {
      refuse("it holds an entry that isn't a file or a folder");
    }
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100);
    const raw = prefix === "" ? name : `${prefix}/${name}`;
    const size = octal(header, 124, 12);
    const folder = type === "5";
    if (folder && size !== 0) refuse("a folder entry has a size");
    if (size > tarLimits.fileBytes) refuse("a file is larger than 16 MiB");
    total += size;
    if (total > tarLimits.totalBytes) refuse("its files add up to over 64 MiB");
    const start = offset + block;
    const padded = Math.ceil(size / block) * block;
    if (start + padded > archive.length) refuse("a file is cut short");
    if (!isZero(archive.subarray(start + size, start + padded))) {
      refuse("a file's padding isn't zero");
    }
    offset = start + padded;
    const path = entryPath(raw, folder);
    if (path === undefined) continue;
    if (entries.length === tarLimits.entries) {
      refuse("it holds more than 1000 entries");
    }
    if (seen.has(path)) {
      refuse(`it holds ${JSON.stringify(path)} twice`);
    }
    const parents = parentsOf(path);
    if (parents.some((parent) => files.has(parent))) {
      refuse(`${JSON.stringify(path)} is inside a file`);
    }
    if (!folder && folders.has(path)) {
      refuse(`${JSON.stringify(path)} is both a file and a folder`);
    }
    seen.add(path);
    for (const parent of parents) folders.add(parent);
    if (folder) {
      folders.add(path);
      entries.push({ kind: "folder", path });
    } else {
      files.add(path);
      entries.push({
        kind: "file",
        path,
        data: archive.subarray(start, start + size),
      });
    }
  }
  return refuse("it has no end marker");
}

export function readTar(archive: Uint8Array): TarResult {
  try {
    return { ok: true, entries: read(archive) };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

export async function writeEntries(
  entries: readonly TarEntry[],
  folder: string,
): Promise<void> {
  const makeFolder = async (path: string) => {
    await mkdir(path, { recursive: true, mode: 0o755 });
    await chmod(path, 0o755);
  };
  for (const entry of entries) {
    const target = join(folder, entry.path);
    if (entry.kind === "folder") {
      await makeFolder(target);
      continue;
    }
    for (const parent of parentsOf(entry.path)) {
      await makeFolder(join(folder, parent));
    }
    const file = await open(target, "wx", 0o644);
    try {
      await file.writeFile(entry.data);
      await file.chmod(0o644);
    } finally {
      await file.close();
    }
  }
}
