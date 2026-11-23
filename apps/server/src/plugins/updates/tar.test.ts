import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readTar, tarLimits, writeEntries, type TarEntry } from "./tar";

interface Spec {
  readonly name: string;
  readonly type?: string;
  readonly data?: string | Uint8Array;
  readonly size?: number;
  readonly prefix?: string;
  readonly magic?: string;
}

function header(spec: Spec): Buffer {
  const block = Buffer.alloc(512);
  const data = spec.data ?? "";
  block.write(spec.name, 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(
    `${(spec.size ?? Buffer.byteLength(data)).toString(8).padStart(11, "0")}\0`,
    124,
  );
  block.write("00000000000\0", 136);
  block.write(spec.type ?? "0", 156);
  block.write(spec.magic ?? "ustar\u000000", 257, "latin1");
  if (spec.prefix) block.write(spec.prefix, 345, "utf8");
  block.fill(" ", 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function tar(...specs: Spec[]): Buffer {
  const parts: Buffer[] = [];
  for (const spec of specs) {
    parts.push(header(spec));
    const data = Buffer.from(spec.data ?? "");
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const reason = (archive: Uint8Array) => {
  const result = readTar(archive);
  return result.ok ? undefined : result.reason;
};

const paths = (archive: Uint8Array) => {
  const result = readTar(archive);
  if (!result.ok) throw new Error(result.reason);
  return result.entries.map((entry) => `${entry.kind} ${entry.path}`);
};

const fixture = readFileSync(
  join(
    import.meta.dirname,
    "fixtures/aphelion-test-plugin/v1.0.0/aphelion-plugin.tar",
  ),
);

describe("readTar", () => {
  test("reads the real release archive, with its ./ root and leading ./", () => {
    expect(paths(fixture)).toEqual([
      "file aphelion-plugin.json",
      "file server.mjs",
    ]);
  });

  test("reads folders with a trailing slash, files inside them, and a ustar prefix", () => {
    expect(
      paths(
        tar(
          { name: "./sub/", type: "5" },
          { name: "./sub/a.js", data: "a" },
          { name: "b.js", type: "\0", data: "b" },
          { prefix: "deep/er", name: "c.js", data: "c" },
        ),
      ),
    ).toEqual([
      "folder sub",
      "file sub/a.js",
      "file b.js",
      "file deep/er/c.js",
    ]);
  });

  test("keeps each file's bytes", () => {
    const result = readTar(tar({ name: "a.txt", data: "hello" }));
    expect(
      result.ok &&
        Buffer.from(
          (result.entries[0] as { data: Uint8Array }).data,
        ).toString(),
    ).toBe("hello");
  });

  test.each([
    ["a symbolic link", { name: "link", type: "2" }],
    ["a hard link", { name: "link", type: "1" }],
    ["a device", { name: "dev", type: "3" }],
    ["a PAX header", { name: "pax", type: "x" }],
    ["a GNU long name", { name: "././@LongLink", type: "L" }],
  ])("refuses %s", (_, spec) => {
    expect(reason(tar(spec))).toBe(
      "it holds an entry that isn't a file or a folder",
    );
  });

  test.each([
    ["a leading slash", "/etc/passwd"],
    ["a parent folder", "../escape.js"],
    ["a parent folder inside", "sub/../../escape.js"],
    ["a dot segment", "sub/./a.js"],
    ["an empty segment", "sub//a.js"],
    ["a backslash", "sub\\a.js"],
    ["a control character", "a\u0001.js"],
    ["a bare root that isn't ./", ""],
  ])("refuses a name with %s", (_, name) => {
    expect(reason(tar({ name, data: "x" }))).toMatch(
      /plain relative path|backslash or a control character|isn't a plain/,
    );
  });

  test("refuses a name with bytes after its NUL", () => {
    expect(reason(tar({ name: "a.js\0hidden", data: "x" }))).toBe(
      "a header field holds bytes after its end",
    );
  });

  test("refuses the same path twice, and a file where a folder is", () => {
    expect(reason(tar({ name: "a.js" }, { name: "./a.js" }))).toBe(
      'it holds "a.js" twice',
    );
    expect(reason(tar({ name: "a/b.js" }, { name: "a" }))).toBe(
      '"a" is both a file and a folder',
    );
    expect(reason(tar({ name: "a" }, { name: "a/b.js" }))).toBe(
      '"a/b.js" is inside a file',
    );
    expect(paths(tar({ name: "a/b.js" }, { name: "a/", type: "5" }))).toEqual([
      "file a/b.js",
      "folder a",
    ]);
  });

  test("refuses a wrong checksum but accepts the right one", () => {
    const archive = tar({ name: "a.js", data: "x" });
    expect(reason(archive)).toBeUndefined();
    archive[0] = "b".charCodeAt(0);
    expect(reason(archive)).toBe("a header's checksum is wrong");
  });

  test("refuses an archive that isn't POSIX ustar", () => {
    expect(reason(tar({ name: "a.js", magic: "ustar  \0" }))).toBe(
      "it isn't a POSIX ustar archive",
    );
  });

  test("refuses broken framing", () => {
    const good = tar({ name: "a.js", data: "x" });
    expect(reason(good.subarray(0, good.length - 1))).toBe(
      "its length isn't whole blocks",
    );
    expect(reason(good.subarray(0, 1024))).toBe("it has no end marker");
    expect(reason(good.subarray(0, 1536))).toBe("its end marker is cut short");
    expect(
      reason(Buffer.concat([good, Buffer.from(header({ name: "late.js" }))])),
    ).toBe("it holds data after its end marker");
    const padded = Buffer.from(good);
    padded[513] = 1;
    expect(reason(padded)).toBe("a file's padding isn't zero");
    expect(
      reason(tar({ name: "a.js", size: 4096 }).subarray(0, 1024 + 1024)),
    ).toBe("a file is cut short");
    expect(reason(tar({ name: "sub", type: "5", size: 1 }))).toBe(
      "a folder entry has a size",
    );
  });

  test("refuses archives over the limits", () => {
    expect(
      reason(tar({ name: "big.bin", size: tarLimits.fileBytes + 1 })),
    ).toBe("a file is larger than 16 MiB");
    const many = Array.from({ length: tarLimits.entries + 1 }, (_, index) => ({
      name: `f${String(index)}`,
    }));
    expect(reason(tar(...many))).toBe("it holds more than 1000 entries");
    expect(paths(tar(...many.slice(1)))).toHaveLength(tarLimits.entries);
    const deep = Array.from({ length: tarLimits.segments + 1 }, () => "d");
    expect(reason(tar({ prefix: deep.slice(1).join("/"), name: "d" }))).toBe(
      `"${deep.join("/")}" is nested too deep`,
    );
    expect(reason(tar({ prefix: "x".repeat(150), name: "y" }))).toBeUndefined();
    expect(
      reason(tar({ prefix: "x".repeat(155), name: "y".repeat(100) })),
    ).toBeUndefined();
  });
});

describe("writeEntries", () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "aphelion-tar-"));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("writes files 0644 and folders 0755, ignoring the archive's modes", async () => {
    const entries: TarEntry[] = [
      { kind: "file", path: "a/b/c.js", data: Buffer.from("c") },
      { kind: "folder", path: "empty" },
    ];
    await writeEntries(entries, folder);
    expect(await readFile(join(folder, "a/b/c.js"), "utf8")).toBe("c");
    expect((await stat(join(folder, "a/b/c.js"))).mode & 0o777).toBe(0o644);
    for (const path of ["a", "a/b", "empty"]) {
      expect((await stat(join(folder, path))).mode & 0o777).toBe(0o755);
    }
    expect((await readdir(folder)).sort()).toEqual(["a", "empty"]);
  });

  test("never writes over an existing file", async () => {
    const entry: TarEntry = {
      kind: "file",
      path: "a.js",
      data: Buffer.from(""),
    };
    await writeEntries([entry], folder);
    await expect(writeEntries([entry], folder)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});
