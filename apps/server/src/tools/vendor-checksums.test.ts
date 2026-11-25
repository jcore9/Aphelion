import { describe, expect, it } from "vitest";
import { sha256, type Build } from "./list";
import {
  claudePlatformFor,
  codexAssetFor,
  mismatches,
  opencodeAssetFor,
  parseClaudeManifest,
  parseGithubAsset,
  parseSha256Sums,
} from "./vendor-checksums";

const sum = (letter: string) => sha256.parse(letter.repeat(64));

const manifest = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: "2.1.330",
    platforms: {
      "linux-x64": { binary: "claude", checksum: "a".repeat(64), size: 1000 },
      "linux-arm64": { binary: "claude", checksum: "b".repeat(64), size: 900 },
    },
    ...overrides,
  });

describe("parseClaudeManifest", () => {
  it("returns the checksum and size of one platform", () => {
    expect(parseClaudeManifest(manifest(), "2.1.330", "linux-arm64")).toEqual({
      ok: true,
      value: { sha256: sum("b"), size: 900 },
    });
  });

  it("refuses a manifest for another version", () => {
    const parsed = parseClaudeManifest(manifest(), "2.1.331", "linux-x64");
    expect(parsed.ok).toBe(false);
  });

  it("refuses a platform the manifest lacks, and a bad checksum or size", () => {
    expect(parseClaudeManifest(manifest(), "2.1.330", "linux-riscv64").ok).toBe(
      false,
    );
    for (const entry of [
      { checksum: "A".repeat(64), size: 1 },
      { checksum: "a".repeat(64), size: 0 },
      { checksum: "a".repeat(64) },
    ]) {
      const text = manifest({ platforms: { "linux-x64": entry } });
      expect(parseClaudeManifest(text, "2.1.330", "linux-x64").ok).toBe(false);
    }
  });

  it("refuses text that isn't a manifest", () => {
    expect(parseClaudeManifest("<html>", "2.1.330", "linux-x64").ok).toBe(
      false,
    );
    expect(parseClaudeManifest("{}", "2.1.330", "linux-x64").ok).toBe(false);
  });
});

describe("parseSha256Sums", () => {
  it("reads text-mode and binary-mode lines and skips the rest", () => {
    const sums = parseSha256Sums(
      [
        `${"a".repeat(64)}  one.tar.gz`,
        `${"b".repeat(64)} *two.tar.gz`,
        `${"C".repeat(64)}  upper.tar.gz`,
        `${"d".repeat(63)}  short.tar.gz`,
        "not a line",
        "",
      ].join("\n"),
    );
    expect([...sums]).toEqual([
      ["one.tar.gz", sum("a")],
      ["two.tar.gz", sum("b")],
    ]);
  });
});

describe("parseGithubAsset", () => {
  const release = (digest: string | null) =>
    JSON.stringify({
      assets: [
        {
          name: "tool.tar.gz",
          size: 42,
          digest,
          browser_download_url:
            "https://github.com/o/r/releases/download/v1/tool.tar.gz",
        },
      ],
    });

  it("returns the address, digest and size of the named asset", () => {
    expect(
      parseGithubAsset(release(`sha256:${"c".repeat(64)}`), "tool.tar.gz"),
    ).toEqual({
      ok: true,
      value: {
        url: "https://github.com/o/r/releases/download/v1/tool.tar.gz",
        sha256: sum("c"),
        size: 42,
      },
    });
  });

  it("refuses an asset that is missing or has no usable digest", () => {
    expect(
      parseGithubAsset(release(`sha256:${"c".repeat(64)}`), "other").ok,
    ).toBe(false);
    expect(parseGithubAsset(release(null), "tool.tar.gz").ok).toBe(false);
    expect(parseGithubAsset(release("sha1:abc"), "tool.tar.gz").ok).toBe(false);
    expect(parseGithubAsset("nope", "tool.tar.gz").ok).toBe(false);
  });
});

describe("mismatches", () => {
  const listed: Build = {
    url: "https://example.com/tool",
    sha256: sum("a"),
    size: 10,
    format: "binary",
    entry: "tool",
  };

  it("finds nothing when the entry matches the vendor", () => {
    expect(mismatches(listed, { ...listed })).toEqual([]);
  });

  it("names each field that differs", () => {
    const found = mismatches(listed, {
      ...listed,
      sha256: sum("b"),
      size: 11,
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain("sha256");
    expect(found[1]).toContain("size");
  });
});

describe("asset names", () => {
  it("maps each processor to the vendor's own name", () => {
    expect(claudePlatformFor("x86_64")).toBe("linux-x64");
    expect(claudePlatformFor("aarch64")).toBe("linux-arm64");
    expect(opencodeAssetFor("aarch64")).toBe("opencode-linux-arm64.tar.gz");
    expect(codexAssetFor("x86_64")).toBe(
      "codex-x86_64-unknown-linux-musl.tar.gz",
    );
  });
});
