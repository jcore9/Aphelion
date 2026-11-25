import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterAll, beforeAll, expect, test } from "vitest";

const main = join(import.meta.dirname, "main.ts");
const example = join(
  import.meta.dirname,
  "../../../../docs/reference/config/example",
);

let root: string;
let configDir: string;
let stateDir: string;
let port: number;

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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "aphelion-main-"));
  configDir = join(root, "etc");
  stateDir = join(root, "state");
  port = await freePort();
  await cp(example, configDir, { recursive: true });
  await writeFile(
    join(configDir, "server.yaml"),
    `version: 1\naddress: 127.0.0.1\nport: ${String(port)}\n`,
  );
  await chmod(configDir, 0o750);
  for (const file of await readdir(configDir)) {
    await chmod(join(configDir, file), 0o640);
  }
  await mkdir(stateDir, { mode: 0o700 });
  await chmod(stateDir, 0o700);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Running {
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
  readonly kill: (signal: NodeJS.Signals) => void;
}

function start(args: string[]): Running {
  const child = spawn(process.execPath, [main, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exited: new Promise((resolve) =>
      child.on("close", (code) => {
        resolve(code);
      }),
    ),
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const dirs = () => ["--config-dir", configDir, "--state-dir", stateDir];

test("aphelion --version runs as a program", async () => {
  const run = start(["--version"]);
  expect(await run.exited).toBe(0);
  expect(run.stdout()).toMatch(/^aphelion \d+\.\d+\.\d+(-[0-9A-Za-z.]+)?\n$/);
});

test("aphelion --headless serves, checks tokens from device add, and stops on SIGTERM", async () => {
  const added = start(["device", "add", "laptop", "--state-dir", stateDir]);
  expect(await added.exited).toBe(0);
  const token = added.stdout().trim();
  expect(token).toMatch(/^aph_dev_/);

  const server = start(["--headless", ...dirs()]);
  try {
    await waitFor(() => server.stdout().includes('"msg":"server started"'));
    const url = `http://127.0.0.1:${String(port)}`;

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('{"status":"ok"}');
    expect((await fetch(`${url}/anything`)).status).toBe(401);
    const authorized = await fetch(`${url}/anything`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authorized.status).toBe(404);
  } finally {
    server.kill("SIGTERM");
  }
  expect(await server.exited).toBe(130);
  expect(server.stdout()).toContain('"msg":"server stopping"');
  expect(server.stdout() + server.stderr()).not.toContain(token);
}, 20_000);

test("aphelion --headless refuses to start when the config check fails", async () => {
  await chmod(stateDir, 0o755);
  try {
    const run = start(["--headless", ...dirs()]);
    expect(await run.exited).toBe(1);
    const line = JSON.parse(run.stdout().trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      msg: "the config check failed, so the server won't start",
      issues: [`${stateDir}: has mode 0755, which is looser than 0700`],
    });
  } finally {
    await chmod(stateDir, 0o700);
  }
}, 20_000);

test("device add revokes the device when the token can't be printed", async () => {
  const full = openSync("/dev/full", "w");
  const child = spawn(
    process.execPath,
    [main, "device", "add", "lost", "--state-dir", stateDir],
    { stdio: ["ignore", full, "pipe"] },
  );
  closeSync(full);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise((resolve) => {
    child.on("close", resolve);
  });
  expect(code).toBe(1);
  expect(stderr).toMatch(
    /^aphelion: couldn't print the token \(.*\), so device [0-9a-f]{16} was revoked\n$/,
  );

  const listed = start(["device", "list", "--state-dir", stateDir]);
  expect(await listed.exited).toBe(0);
  expect(listed.stdout()).toMatch(/\trevoked\t[^\n]*\t"lost"\n/);
}, 20_000);

test("config check --compose - reads a pipe", async () => {
  const serverFile = join(configDir, "server.yaml");
  await writeFile(serverFile, "version: 1\naddress: 0.0.0.0\nport: 7400\n");
  try {
    const child = spawn(
      process.execPath,
      [main, "config", "check", ...dirs(), "--compose", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stdin.end(
      "services:\n  aphelion:\n    ports: ['100.71.226.67:7400:7400']\n",
    );
    const code = await new Promise((resolve) => {
      child.on("close", resolve);
    });
    expect(code).toBe(0);
    expect(stdout).toBe(
      "Config OK. The Compose file publishes ports only on the tailnet, and server.yaml sets address 0.0.0.0 and port 7400.\n",
    );
  } finally {
    await writeFile(
      serverFile,
      `version: 1\naddress: 127.0.0.1\nport: ${String(port)}\n`,
    );
  }
}, 20_000);

test("aphelion --headless starts installed plugins through the runner pipe", async () => {
  const folder = join(root, "probe-plugin");
  await mkdir(folder);
  const manifest = JSON.stringify({
    id: "probe",
    version: "1.0.0",
    api: "^0.2.0",
    server: { entry: "index.js" },
    permissions: {},
  });
  await writeFile(join(folder, "aphelion-plugin.json"), manifest);
  const command = ["plugin", "install", folder, "--state-dir", stateDir];
  const preview = start(command);
  expect(await preview.exited).toBe(0);
  const approval = /--approve ([0-9a-f]{64})$/m.exec(preview.stdout())?.[1];
  expect(approval).toBeDefined();
  const install = start([...command, "--approve", approval ?? ""]);
  expect(await install.exited).toBe(0);

  const child = spawn(
    process.execPath,
    [main, "--headless", ...dirs(), "--plugin-runner-fds", "3,4"],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let requests = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const replies = child.stdio[3] as Writable;
  (child.stdio[4] as Readable).on(
    "data",
    (chunk: Buffer) => (requests += chunk.toString()),
  );
  const exited = new Promise((resolve) => child.on("close", resolve));
  try {
    await waitFor(() => requests.includes("\n"));
    expect(JSON.parse(requests.split("\n")[0] ?? "")).toEqual({
      type: "start",
      plugin: "probe",
      run: 1,
      folder,
      entry: "index.js",
    });
    expect(stdout).toContain('"msg":"plugin host started","installed":1');
    const socketPath = join(stateDir, "plugin-control.sock");
    await waitFor(() => existsSync(socketPath));
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(await ask(socketPath, { type: "reload", folder })),
    ).toEqual({ type: "refused", reason: "dev mode is off" });
    replies.end();
    await waitFor(() => stdout.includes("the plugin runner's pipe closed"));
  } finally {
    child.kill("SIGTERM");
  }
  expect(await exited).toBe(130);
}, 20_000);

function ask(socketPath: string, request: object) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      resolve(chunk.toString());
      socket.end();
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

test("aphelion --headless --plugin-dev opens a private control socket and removes it on stop", async () => {
  const devFolder = join(root, "dev-plugin");
  await mkdir(devFolder);
  const socketPath = join(stateDir, "plugin-control.sock");
  const child = spawn(
    process.execPath,
    [
      main,
      "--headless",
      ...dirs(),
      "--plugin-runner-fds",
      "3,4",
      "--plugin-dev",
      devFolder,
    ],
    { stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  const exited = new Promise((resolve) => child.on("close", resolve));
  try {
    await waitFor(() => stdout.includes('"msg":"plugin dev mode is on"'));
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const reply = await ask(socketPath, { type: "reload", folder: root });
    expect(JSON.parse(reply)).toEqual({
      type: "refused",
      reason: `dev mode reloads only ${devFolder}, not ${JSON.stringify(root)}`,
    });
  } finally {
    child.kill("SIGTERM");
  }
  expect(await exited).toBe(130);
  expect(existsSync(socketPath)).toBe(false);
}, 20_000);
