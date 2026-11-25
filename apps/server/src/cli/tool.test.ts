import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Cause, Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { lockFile } from "../adapters/file-lock";
import { filesLockFile } from "../plugins/updates/files-lock";
import { cli, CliFailure, CliIo } from "./index";

const run = promisify(execFile);

let root: string;
let stateDir: string;
let toolsDir: string;
let server: Server;
let served: Map<string, Buffer>;
let requests: string[];

const origin = () =>
  `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-tool-cli-"));
  stateDir = join(root, "state");
  toolsDir = join(root, "tools");
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(toolsDir);
  served = new Map();
  requests = [];
  server = createServer((request, response) => {
    const body = served.get(request.url ?? "");
    requests.push(request.url ?? "");
    if (body !== undefined && request.url?.startsWith("/chunked")) {
      response.write(body.subarray(0, 10));
      response.end(body.subarray(10));
      return;
    }
    response.statusCode = body === undefined ? 404 : 200;
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env["APHELION_TOOL_LIST"] = join(root, "ai-tools.json");
});

afterEach(async () => {
  delete process.env["APHELION_TOOL_LIST"];
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

async function invoke(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(""),
  });
  const exit = await Effect.runPromiseExit(cli(argv).pipe(Effect.provide(io)));
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
  }
  return { code, out, err };
}

const dirs = () => ["--state-dir", stateDir, "--tools-dir", toolsDir];
const listArgs = () => ["tool", "list", "--tools-dir", toolsDir];
const install = (name = "claude") =>
  invoke(["tool", "install", name, ...dirs()]);

const script = Buffer.from("#!/bin/sh\necho hello from the tool\n");

interface Fixture {
  readonly path: string;
  readonly bytes: Buffer;
  readonly format: "binary" | "tar.gz";
  readonly entry: string;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function writeList(
  fixture: Fixture,
  overrides: { version?: string; sha256?: string; size?: number } = {},
  name = "claude",
) {
  served.set(fixture.path, fixture.bytes);
  const build = {
    url: `${origin()}${fixture.path}`,
    sha256: overrides.sha256 ?? sha(fixture.bytes),
    size: overrides.size ?? fixture.bytes.length,
    format: fixture.format,
    entry: fixture.entry,
  };
  await writeEntry({
    version: overrides.version ?? "1.2.3",
    name,
    build,
  });
}

async function writeEntry(options: {
  version: string;
  name: string;
  build: Record<string, unknown>;
  builds?: Record<string, unknown>;
}) {
  const tool = {
    name: options.name,
    version: options.version,
    builds: options.builds ?? {
      x86_64: options.build,
      aarch64: options.build,
    },
    signIn: [options.name, "auth", "login"],
    status: [options.name, "auth", "status"],
    checksumSource: "recorded",
  };
  await writeFile(
    process.env["APHELION_TOOL_LIST"] ?? "",
    JSON.stringify({ version: 1, tools: [tool] }),
  );
}

const binary: Fixture = {
  path: "/claude",
  bytes: script,
  format: "binary",
  entry: "claude",
};

async function archive(
  files: Record<string, string>,
  extra: string[] = [],
  links: Record<string, string> = {},
) {
  const source = await mkdtemp(join(root, "source-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content, { mode: 0o755 });
  }
  for (const [name, target] of Object.entries(links)) {
    await symlink(target, join(source, name));
  }
  const file = join(root, `${source.split("-").at(-1) ?? "x"}.tar.gz`);
  const made = spawnSync("tar", [
    "-czf",
    file,
    "-C",
    source,
    ...extra,
    ...Object.keys(files),
    ...Object.keys(links),
  ]);
  expect(made.status).toBe(0);
  return readFile(file);
}

const stateOf = async (name = "claude") =>
  (await invoke(listArgs())).out.find((row) => row.startsWith(`${name}\t`));

test("tool list shows each tool, its state and its status command", async () => {
  await writeList(binary);
  expect(await invoke(listArgs())).toEqual({
    code: 0,
    out: [
      "NAME\tVERSION\tSTATE\tSTATUS-COMMAND",
      "claude\t1.2.3\tnot installed\tclaude auth status",
    ],
    err: [],
  });
});

test("tool list says unavailable for a tool with no build for this processor", async () => {
  await writeEntry({
    version: "1.2.3",
    name: "claude",
    build: {},
    builds: {},
  });
  expect((await invoke(listArgs())).out[1]).toBe(
    "claude\t1.2.3\tunavailable\tclaude auth status",
  );
  const refused = await install();
  expect(refused.code).toBe(1);
  expect(refused.err[0]).toContain("has no build");
});

test("tool install downloads a binary, checks it, and bots can run it", async () => {
  await writeList(binary);
  const result = await install();
  expect(result).toEqual({
    code: 0,
    out: [
      "Installed claude 1.2.3.",
      "Sign in as aphelion-bot with: claude auth login",
    ],
    err: [],
  });
  const program = join(toolsDir, "claude", "current", "claude");
  expect((await stat(program)).mode & 0o777).toBe(0o755);
  expect((await run(program)).stdout).toBe("hello from the tool\n");
  expect(await readlink(join(toolsDir, "claude", "current"))).toBe("1.2.3");
  expect(await stateOf()).toBe("claude\t1.2.3\tinstalled\tclaude auth status");
  expect(await readdir(toolsDir)).toEqual(["claude"]);
});

test("installing the installed version again downloads nothing and changes nothing", async () => {
  await writeList(binary);
  await install();
  const inode = (await stat(join(toolsDir, "claude", "1.2.3", "claude"))).ino;
  const again = await install();
  expect(again.out[0]).toBe("claude 1.2.3 is already installed.");
  expect(requests).toEqual(["/claude"]);
  expect((await stat(join(toolsDir, "claude", "1.2.3", "claude"))).ino).toBe(
    inode,
  );
});

test("tool install refuses a wrong checksum and leaves nothing behind", async () => {
  await writeList(binary, { sha256: "0".repeat(64) });
  const result = await install();
  expect(result.code).toBe(1);
  expect(result.out).toEqual([]);
  expect(result.err[0]).toMatch(/SHA-256 is [0-9a-f]{64}, not the 0{64}/);
  expect(await readdir(toolsDir)).toEqual([]);
  expect(await stateOf()).toContain("not installed");
});

test("tool install refuses a download bigger than the list says, and a smaller one", async () => {
  await writeList(binary, { size: script.length - 1 });
  const bigger = await install();
  expect(bigger.code).toBe(1);
  expect(bigger.err[0]).toMatch(/more than|larger than/);
  await writeList(binary, { size: script.length + 1 });
  const smaller = await install();
  expect(smaller.code).toBe(1);
  expect(smaller.err[0]).toContain("not the");
  expect(await readdir(toolsDir)).toEqual([]);
  await writeList(binary);
  expect((await install()).code).toBe(0);
});

test("tool install stops a download with no announced size once it passes the list's size", async () => {
  await writeList({ ...binary, path: "/chunked" }, { size: script.length - 1 });
  const result = await install();
  expect(result.code).toBe(1);
  expect(result.err[0]).toContain("larger than");
  expect(await readdir(toolsDir)).toEqual([]);
  await writeList({ ...binary, path: "/chunked" });
  expect((await install()).code).toBe(0);
});

test("tool install refuses a name that isn't on the list or isn't a tool name", async () => {
  await writeList(binary);
  const missing = await install("codex");
  expect(missing.code).toBe(1);
  expect(missing.err[0]).toContain("isn't on the list");
  const unknown = await install("gemini");
  expect(unknown.code).toBe(2);
  expect(unknown.err[0]).toContain(
    "the tool name must be claude, codex, grok or opencode",
  );
  expect(requests).toEqual([]);
});

test("tool install refuses a list it can't read or that is invalid", async () => {
  expect((await install()).err[0]).toContain("can't read the tool list");
  await writeFile(process.env["APHELION_TOOL_LIST"] ?? "", "{}");
  const invalid = await install();
  expect(invalid.code).toBe(1);
  expect(invalid.err[0]).toContain("the tool list is invalid");
});

test("tool install unpacks a gzip archive with the program in a folder", async () => {
  const bytes = await archive({
    "bin/tool": "#!/bin/sh\necho from the archive\n",
    "share/readme": "text",
  });
  await writeList({
    path: "/tool.tar.gz",
    bytes,
    format: "tar.gz",
    entry: "bin/tool",
  });
  expect((await install()).code).toBe(0);
  const program = join(toolsDir, "claude", "current", "bin", "tool");
  expect((await run(program)).stdout).toBe("from the archive\n");
  expect(
    (await stat(join(toolsDir, "claude", "1.2.3", "share"))).mode & 0o777,
  ).toBe(0o755);
});

test.each([
  [
    "a member outside its folder",
    { tool: "x" },
    ["--transform", "s,^,../,"],
    {},
    "outside its folder",
  ],
  ["a link", { tool: "x" }, [], { link: "/etc/passwd" }, "link"],
  ["no program at the entry path", { other: "x" }, [], {}, "has no tool"],
])(
  "tool install refuses an archive with %s",
  async (_label, files, extra, links, reason) => {
    const bytes = await archive(files, extra, links);
    await writeList({
      path: "/bad.tar.gz",
      bytes,
      format: "tar.gz",
      entry: "tool",
    });
    const result = await install();
    expect(result.code).toBe(1);
    expect(result.err[0]).toContain(reason);
    expect(result.out).toEqual([]);
    expect(await readdir(toolsDir)).toEqual([]);
  },
);

test("a new list version replaces the old one, and leftovers from a crash are cleaned", async () => {
  await writeList(binary);
  await install();
  await mkdir(join(toolsDir, ".staging", "junk"), { recursive: true });
  await symlink("1.2.3", join(toolsDir, "claude", "current.new-abc"));
  const next = { ...binary, bytes: Buffer.from("#!/bin/sh\necho second\n") };
  await writeList(next, { version: "1.3.0" });
  expect(await stateOf()).toContain("not installed");
  expect((await install()).out[0]).toBe("Installed claude 1.3.0.");
  expect((await readdir(join(toolsDir, "claude"))).sort()).toEqual([
    "1.3.0",
    "current",
  ]);
  expect(
    (await run(join(toolsDir, "claude", "current", "claude"))).stdout,
  ).toBe("second\n");
  expect(await readdir(toolsDir)).toEqual(["claude"]);
});

test("an install that died after the move but before the switch is finished by the next run", async () => {
  await writeList(binary);
  await mkdir(join(toolsDir, "claude", "1.2.3"), { recursive: true });
  await writeFile(join(toolsDir, "claude", "1.2.3", "claude"), "half");
  expect(await stateOf()).toContain("not installed");
  expect((await install()).code).toBe(0);
  expect(
    (await run(join(toolsDir, "claude", "current", "claude"))).stdout,
  ).toBe("hello from the tool\n");
});

test("tool install refuses while another install holds the lock", async () => {
  await writeList(binary);
  const lock = lockFile(join(stateDir, filesLockFile));
  const result = await install();
  if (lock.kind === "locked") lock.release();
  expect(result.code).toBe(1);
  expect(result.err[0]).toContain(
    "Another AI tool install or remove is running",
  );
  expect((await install()).code).toBe(0);
});

test("tool remove deletes the tool and can run twice", async () => {
  await writeList(binary);
  await install();
  const remove = ["tool", "remove", "claude", ...dirs()];
  expect((await invoke(remove)).out).toEqual([
    "Removed claude. Its sign-in in the bots volume is still there.",
  ]);
  await expect(lstat(join(toolsDir, "claude"))).rejects.toThrow();
  expect(await invoke(remove)).toEqual({
    code: 0,
    out: ["claude isn't installed."],
    err: [],
  });
  expect(await stateOf()).toContain("not installed");
});
