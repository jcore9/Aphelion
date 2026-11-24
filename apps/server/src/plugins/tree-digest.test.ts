import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterAll, beforeAll, describe } from "vitest";
import { filesDigest } from "./tree-digest";

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "aphelion-tree-"));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const tree = (files: Record<string, string>) =>
  Effect.promise(async () => {
    const root = await mkdtemp(join(base, "case-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return root;
  });

const reason = (root: string) =>
  filesDigest(root).pipe(
    Effect.flip,
    Effect.map((refused) => refused.reason),
  );

describe("the files digest", () => {
  it.effect(
    "hashes every regular file, hidden ones included, sorted by UTF-8 bytes",
    () =>
      Effect.gen(function* () {
        const files = {
          "aphelion-plugin.json": "{}",
          ".hidden": "h",
          "lib/\u{FF5E}.js": "wide",
          "lib/\u{1F600}.js": "emoji",
        };
        const root = yield* tree(files);
        expect(yield* filesDigest(root)).toBe(
          sha256(
            JSON.stringify([
              [".hidden", sha256("h")],
              ["aphelion-plugin.json", sha256("{}")],
              ["lib/\u{FF5E}.js", sha256("wide")],
              ["lib/\u{1F600}.js", sha256("emoji")],
            ]),
          ),
        );
        expect(yield* filesDigest(yield* tree(files))).toBe(
          yield* filesDigest(root),
        );
        const changed = yield* tree({ ...files, ".hidden": "i" });
        expect(yield* filesDigest(changed)).not.toBe(yield* filesDigest(root));
      }),
  );

  it.effect("refuses a symbolic link", () =>
    Effect.gen(function* () {
      const root = yield* tree({ "index.js": "" });
      yield* Effect.promise(() => symlink("index.js", join(root, "link.js")));
      expect(yield* reason(root)).toBe(
        "link.js isn't a regular file or a folder",
      );
    }),
  );

  it.effect("accepts 1000 files and refuses 1001", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [`f${String(index)}`, ""]),
      );
      const root = yield* tree(files);
      expect(yield* filesDigest(root)).toMatch(/^[0-9a-f]{64}$/);
      yield* Effect.promise(() => writeFile(join(root, "one-more"), ""));
      expect(yield* reason(root)).toBe("it has more than 1000 files");
    }),
  );

  it.effect("accepts 64 MiB of files and refuses one byte more", () =>
    Effect.gen(function* () {
      const root = yield* tree({ big: "", small: "" });
      yield* Effect.promise(() =>
        truncate(join(root, "big"), 64 * 1024 * 1024),
      );
      expect(yield* filesDigest(root)).toMatch(/^[0-9a-f]{64}$/);
      yield* Effect.promise(() => writeFile(join(root, "small"), "x"));
      expect(yield* reason(root)).toBe("its files add up to more than 64 MiB");
    }),
  );
});
