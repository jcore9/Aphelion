import { describe, expect, it } from "vitest";
import { permissionRequestFor, toolKind } from "./tools.ts";

const ask = (tool: string, input: Record<string, unknown>) =>
  permissionRequestFor({ tool, input, call: "toolu_01", request: "req-1" });

describe("toolKind", () => {
  it("maps each Claude tool to its kind, and any other name to other", () => {
    expect(
      [
        "Read",
        "Glob",
        "Grep",
        "Write",
        "Edit",
        "NotebookEdit",
        "Bash",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "Agent",
        "mcp__files__read",
        "constructor",
      ].map(toolKind),
    ).toEqual([
      "file.read",
      "file.read",
      "file.read",
      "file.write",
      "file.write",
      "file.write",
      "shell",
      "web",
      "web",
      "other",
      "other",
      "other",
      "other",
    ]);
  });
});

describe("permissionRequestFor", () => {
  it("gives the decider the paths a file tool names", () => {
    expect(
      ask("Write", { file_path: "/work/a.md", content: "x" }),
    ).toMatchObject({
      kind: "file.write",
      paths: ["/work/a.md"],
      command: null,
    });
    expect(
      ask("NotebookEdit", { notebook_path: "/work/n.ipynb" })?.paths,
    ).toEqual(["/work/n.ipynb"]);
    expect(
      ask("Glob", { pattern: "../**/*.key", path: "/work" })?.paths,
    ).toEqual(["/work", "../**/*.key"]);
    expect(ask("Read", { file_path: 42 })?.paths).toEqual([]);
  });

  it("gives a search with no path the folder, and leaves out Grep's regex", () => {
    expect(ask("Glob", { pattern: "**/*.md" })?.paths).toEqual([
      ".",
      "**/*.md",
    ]);
    expect(ask("Grep", { pattern: "/etc/.*" })?.paths).toEqual(["."]);
    expect(
      ask("Grep", { pattern: "x", path: "/work/src", glob: "*.ts" })?.paths,
    ).toEqual(["/work/src", "*.ts"]);
  });

  it("gives the decider a shell tool's command and no command for other tools", () => {
    expect(ask("Bash", { command: "ls -la" })).toMatchObject({
      kind: "shell",
      paths: [],
      command: "ls -la",
    });
    expect(ask("Write", { file_path: "/work/a", command: "ls" })?.command).toBe(
      null,
    );
  });

  it("cuts a path or command longer than 4096 bytes and says so", () => {
    const long = `/work/${"ü".repeat(3000)}`;
    const request = ask("Read", { file_path: long });
    expect(new TextEncoder().encode(request?.paths[0]).length).toBe(4096);
    expect(long.startsWith(request?.paths[0] ?? "-")).toBe(true);
    expect(request?.truncated).toBe(true);
    expect(ask("Bash", { command: "x".repeat(5000) })).toMatchObject({
      command: "x".repeat(4096),
      truncated: true,
    });
    expect(ask("Read", { file_path: "/work/a" })?.truncated).toBe(false);
  });

  it("refuses ids or a tool name that don't fit the contract", () => {
    expect(
      permissionRequestFor({
        tool: "Read",
        input: {},
        call: "a b",
        request: "r",
      }),
    ).toBeUndefined();
    expect(
      permissionRequestFor({ tool: "Read", input: {}, call: "c", request: "" }),
    ).toBeUndefined();
    expect(ask("bad name", {})).toBeUndefined();
    expect(ask("Read", {})).toBeDefined();
  });
});
