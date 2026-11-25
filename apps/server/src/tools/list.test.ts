import { describe, expect, it } from "vitest";
import { buildFor, parseToolList, processorFor } from "./list";

const sha = "a".repeat(64);

const build = (overrides: Record<string, unknown> = {}) => ({
  url: "https://example.com/tool",
  sha256: sha,
  size: 1024,
  format: "binary",
  entry: "claude",
  ...overrides,
});

const tool = (overrides: Record<string, unknown> = {}) => ({
  name: "claude",
  version: "2.1.330",
  builds: { x86_64: build(), aarch64: build({ sha256: "b".repeat(64) }) },
  signIn: ["claude", "auth", "login"],
  status: ["claude", "auth", "status", "--text"],
  checksumSource: "vendor-manifest",
  ...overrides,
});

const list = (tools: unknown[] = [tool()]) =>
  JSON.stringify({ version: 1, tools });

const message = (text: string) => {
  const parsed = parseToolList(text);
  if (parsed.ok) throw new Error("the list was accepted");
  return parsed.message;
};

describe("parseToolList", () => {
  it("accepts a list with a build for each processor", () => {
    const parsed = parseToolList(list());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.list.tools.map(({ name }) => name)).toEqual(["claude"]);
  });

  it("accepts a tool with no status command and a gzip build", () => {
    const parsed = parseToolList(
      list([
        tool({
          name: "grok",
          signIn: ["grok", "login"],
          status: undefined,
          checksumSource: "recorded",
          builds: {
            x86_64: build({ format: "tar.gz", entry: "bin/grok" }),
          },
        }),
      ]),
    );
    expect(parsed.ok).toBe(true);
  });

  it.each([
    ["uppercase hex", "A".repeat(64)],
    ["63 digits", "a".repeat(63)],
    ["65 digits", "a".repeat(65)],
    ["non-hex letters", "g".repeat(64)],
    ["a prefix", `sha256:${sha}`],
  ])("rejects a checksum with %s", (_label, value) => {
    expect(
      message(list([tool({ builds: { x86_64: build({ sha256: value }) } })])),
    ).toContain("sha256");
  });

  it("rejects an entry that leaves its folder or is absolute", () => {
    for (const entry of [
      "../claude",
      "/usr/bin/claude",
      "a/../b",
      "a//b",
      "",
    ]) {
      const text = list([
        tool({ builds: { x86_64: build({ format: "tar.gz", entry }) } }),
      ]);
      expect(parseToolList(text).ok, entry).toBe(false);
    }
  });

  it("rejects a binary whose entry is a path, and accepts a gzip entry that is one", () => {
    expect(
      parseToolList(
        list([tool({ builds: { x86_64: build({ entry: "bin/claude" }) } })]),
      ).ok,
    ).toBe(false);
    expect(
      parseToolList(
        list([
          tool({
            builds: {
              x86_64: build({ format: "tar.gz", entry: "bin/claude" }),
            },
          }),
        ]),
      ).ok,
    ).toBe(true);
  });

  it("rejects a missing field", () => {
    for (const field of ["url", "sha256", "size", "format", "entry"]) {
      const rest = Object.fromEntries(
        Object.entries(build()).filter(([key]) => key !== field),
      );
      const parsed = parseToolList(list([tool({ builds: { x86_64: rest } })]));
      expect(parsed.ok, field).toBe(false);
    }
    const noSource = Object.fromEntries(
      Object.entries(tool()).filter(([key]) => key !== "checksumSource"),
    );
    expect(parseToolList(list([noSource])).ok).toBe(false);
  });

  it("rejects a tool name that isn't one of the four", () => {
    expect(
      parseToolList(
        list([tool({ name: "gemini", signIn: ["gemini", "login"] })]),
      ).ok,
    ).toBe(false);
  });

  it("rejects a name listed twice", () => {
    expect(message(list([tool(), tool({ version: "2.1.331" })]))).toContain(
      "twice",
    );
  });

  it("rejects an unknown field, so a typo can't hide a setting", () => {
    expect(parseToolList(list([tool({ autoupdate: false })])).ok).toBe(false);
    expect(
      parseToolList(
        list([tool({ builds: { x86_64: build({ shasum: sha }) } })]),
      ).ok,
    ).toBe(false);
    expect(
      parseToolList(
        JSON.stringify({ version: 1, tools: [tool()], extra: true }),
      ).ok,
    ).toBe(false);
  });

  it("rejects a processor other than x86_64 and aarch64", () => {
    expect(
      parseToolList(list([tool({ builds: { riscv64: build() } })])).ok,
    ).toBe(false);
  });

  it("rejects a version that isn't three numbers, because it names a folder", () => {
    for (const version of ["2.1", "../2.1.330", "2.1.330-beta", "v2.1.330"]) {
      expect(parseToolList(list([tool({ version })])).ok, version).toBe(false);
    }
  });

  it("rejects a size that isn't a positive whole number under 1 GiB", () => {
    for (const size of [0, -1, 1.5, "10", 1024 ** 3 + 1]) {
      const text = list([tool({ builds: { x86_64: build({ size }) } })]);
      expect(parseToolList(text).ok, String(size)).toBe(false);
    }
  });

  it("rejects a URL that isn't http or https, or that holds a password", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/tool",
      "https://user:pass@example.com/tool",
      "not a url",
    ]) {
      const text = list([tool({ builds: { x86_64: build({ url }) } })]);
      expect(parseToolList(text).ok, url).toBe(false);
    }
  });

  it("rejects a sign-in or status command that doesn't start with the tool's name", () => {
    expect(parseToolList(list([tool({ signIn: ["codex", "login"] })])).ok).toBe(
      false,
    );
    expect(
      parseToolList(list([tool({ status: ["sh", "-c", "true"] })])).ok,
    ).toBe(false);
    expect(parseToolList(list([tool({ signIn: [] })])).ok).toBe(false);
  });

  it("rejects text that isn't JSON, and another list version", () => {
    expect(message("not json")).toContain("JSON");
    expect(parseToolList(JSON.stringify({ version: 2, tools: [] })).ok).toBe(
      false,
    );
  });
});

describe("buildFor", () => {
  const parsed = parseToolList(
    list([
      tool({
        builds: { x86_64: build() },
      }),
    ]),
  );
  if (!parsed.ok) throw new Error(parsed.message);
  const [claude] = parsed.list.tools;
  if (claude === undefined) throw new Error("no tool");

  it("returns the build for a processor that has one", () => {
    const found = buildFor(claude, "x86_64");
    expect(found.kind).toBe("available");
    if (found.kind === "available") expect(found.build.size).toBe(1024);
  });

  it("says unavailable for a processor with no build", () => {
    expect(buildFor(claude, "aarch64").kind).toBe("unavailable");
  });
});

describe("processorFor", () => {
  it("maps the Node architecture names", () => {
    expect(processorFor("x64")).toBe("x86_64");
    expect(processorFor("arm64")).toBe("aarch64");
  });

  it("returns nothing for another architecture", () => {
    expect(processorFor("riscv64")).toBeUndefined();
  });
});
