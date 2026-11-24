import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, expect, test } from "vitest";

const main = join(import.meta.dirname, "main.ts");
const runnerMain = join(import.meta.dirname, "../plugins/runner-main.ts");
const example = join(
  import.meta.dirname,
  "../../../../docs/reference/config/example",
);
const uid = process.getuid?.() ?? 0;

const plugin = (onShutdown: string) => `
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const data = process.env.APHELION_PLUGIN_DATA;
writeFileSync(data + "/pid", String(process.pid));
setInterval(() => undefined, 1000);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else if (message.method === "shutdown") {
    ${onShutdown}
  }
}
`;

const plugins = {
  cooperative: plugin(
    `writeFileSync(data + "/saved", "bye"); process.exit(0);`,
  ),
  stubborn: plugin(""),
};

let root: string | undefined;
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  if (root === undefined) return;
  await chmod(root, 0o755).catch(() => undefined);
  await chmod(join(root, "plugins"), 0o755).catch(() => undefined);
  for (const id of Object.keys(plugins)) {
    await chmod(join(root, "plugins", id), 0o755).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
  root = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address !== null)
          resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const exitOf = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function setUp() {
  root = await mkdtemp(join(tmpdir(), "aphelion-plugin-stop-"));
  const configDir = join(root, "etc");
  const stateDir = join(root, "state");
  const dataDir = join(root, "data");
  await cp(example, configDir, { recursive: true });
  await writeFile(
    join(configDir, "server.yaml"),
    `version: 1\naddress: 127.0.0.1\nport: ${String(await freePort())}\n`,
  );
  await chmod(configDir, 0o750);
  for (const file of await readdir(configDir)) {
    await chmod(join(configDir, file), 0o640);
  }
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(dataDir);
  const dirs = ["--config-dir", configDir, "--state-dir", stateDir];
  for (const [id, source] of Object.entries(plugins)) {
    const folder = join(root, "plugins", id);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "index.js"), source);
    const manifest = JSON.stringify({
      id,
      version: "1.0.0",
      api: "^0.2.0",
      server: { entry: "index.js" },
      permissions: {},
    });
    await writeFile(join(folder, "aphelion-plugin.json"), manifest);
    const command = [
      main,
      "plugin",
      "install",
      folder,
      "--state-dir",
      stateDir,
    ];
    const preview = spawnSync(process.execPath, command, { encoding: "utf8" });
    expect(preview.status, preview.stderr).toBe(0);
    const approval = /--approve ([0-9a-f]{64})$/m.exec(preview.stdout)?.[1];
    expect(approval).toBeDefined();
    const install = spawnSync(
      process.execPath,
      [...command, "--approve", approval ?? ""],
      { encoding: "utf8" },
    );
    expect(install.status, install.stderr).toBe(0);
    for (const file of ["index.js", "aphelion-plugin.json"]) {
      await chmod(join(folder, file), 0o444);
    }
    await chmod(folder, 0o555);
  }
  await chmod(join(root, "plugins"), 0o555);
  await chmod(root, 0o555);
  return { dirs, dataDir };
}

test.skipIf(process.platform !== "linux" || uid === 0)(
  "aphelion --headless lets plugins stop gently on SIGTERM, and kills one that doesn't",
  async () => {
    const { dirs, dataDir } = await setUp();
    const options = {
      bun: process.execPath,
      data: dataDir,
      pluginUid: uid + 1,
    };
    const runner = spawn(
      process.execPath,
      [
        "-e",
        `import { serveRunner } from ${JSON.stringify(runnerMain)};
await serveRunner(${JSON.stringify(options)});
process.exit(0);`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    children.push(runner);
    const server = spawn(
      process.execPath,
      [main, "--headless", ...dirs, "--plugin-runner-fds", "3,4"],
      { stdio: ["ignore", "pipe", "inherit", "pipe", "pipe"] },
    );
    children.push(server);
    runner.stdout.pipe(server.stdio[3] as Writable);
    (server.stdio[4] as Readable).pipe(runner.stdin);
    let log = "";
    server.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
    const serverExit = exitOf(server);
    const runnerExit = exitOf(runner);
    const entries = () =>
      log
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const reached = (id: string, state: string) =>
      entries().some(
        (entry) =>
          entry["msg"] === "plugin state changed" &&
          entry["plugin"] === id &&
          entry["to"] === state,
      );

    await waitFor(
      () => reached("cooperative", "running") && reached("stubborn", "running"),
    );
    const stubbornPid = Number(
      await readFile(join(dataDir, "stubborn", "pid"), "utf8"),
    );
    expect(isAlive(stubbornPid)).toBe(true);

    const begun = Date.now();
    server.kill("SIGTERM");
    expect(await serverExit).toBe(130);
    const took = Date.now() - begun;

    expect(existsSync(join(dataDir, "cooperative", "saved"))).toBe(true);
    expect(reached("cooperative", "stopped")).toBe(true);
    expect(reached("stubborn", "stopped")).toBe(true);
    expect(entries()).toContainEqual(
      expect.objectContaining({
        msg: "the plugin host is stopping every plugin",
        plugins: 2,
      }),
    );
    await waitFor(() => !isAlive(stubbornPid), 2_000);
    expect(took).toBeGreaterThanOrEqual(4_500);
    expect(took).toBeLessThan(20_000);
    expect(await runnerExit).toBe(0);
  },
  30_000,
);
