import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  expect(run.stdout()).toMatch(/^aphelion \d+\.\d+\.\d+\n$/);
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
    "Config OK, and the Compose file publishes ports only on the tailnet.\n",
  );
}, 20_000);
