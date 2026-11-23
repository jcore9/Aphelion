import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pluginApiVersion, type ServerPlugin } from "@aphelion/plugin-sdk";
import { createTestHost } from "@aphelion/plugin-sdk/testing";
import { afterEach, describe, expect, test } from "vitest";

const stdio = fileURLToPath(
  new URL("../../../../packages/plugin-sdk/src/stdio.ts", import.meta.url),
);

const manifest = {
  id: "shutdown-order",
  version: "1.0.0",
  api: "^0.2.0",
  server: { entry: "main.mjs" },
  permissions: { events: ["demo.ping"] },
};

const pluginSource = `
export const shutdownPlugin = (pause) => ({
  async start(ctx) {
    await ctx.events.subscribe("demo.ping", async (data) => {
      ctx.log(data + " started");
      await pause();
      ctx.log(data + " finished");
    });
    return () => {
      ctx.log("cleanup");
    };
  },
});
`;

const mainSource = `
import { existsSync } from "node:fs";
import { main } from ${JSON.stringify(stdio)};
import { shutdownPlugin } from "./plugin.mjs";

const release = process.argv[2];
main(shutdownPlugin(async () => {
  while (!existsSync(release)) await new Promise((done) => setTimeout(done, 10));
}));
`;

const expectedOrder = ["first started", "first finished", "cleanup"];

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean) {
  for (let tries = 0; tries < 500 && !check(); tries++) await later(10);
  expect(check()).toBe(true);
}

let folder: string | undefined;

afterEach(async () => {
  if (folder) await rm(folder, { recursive: true, force: true });
  folder = undefined;
});

async function pluginFolder() {
  folder = await mkdtemp(join(tmpdir(), "aphelion-shutdown-"));
  await writeFile(join(folder, "plugin.mjs"), pluginSource);
  await writeFile(join(folder, "main.mjs"), mainSource);
  const { shutdownPlugin } = (await import(
    pathToFileURL(join(folder, "plugin.mjs")).href
  )) as { shutdownPlugin: (pause: () => Promise<void>) => ServerPlugin };
  return { folder, shutdownPlugin };
}

async function onTestHost(
  shutdownPlugin: (pause: () => Promise<void>) => ServerPlugin,
) {
  const host = createTestHost(manifest);
  host.setGrants([{ kind: "events", name: "demo.ping" }]);
  const release = Promise.withResolvers<undefined>();
  await host.start(shutdownPlugin(() => release.promise));
  const first = host.publish("demo.ping", "first");
  await until(() => host.logs.includes("first started"));
  const stopping = host.stop();
  await host.publish("demo.ping", "second");
  release.resolve(undefined);
  await Promise.all([first, stopping]);
  return host.logs;
}

async function asOwnProgram(dir: string) {
  const releaseFile = join(dir, "release");
  const child = spawn(process.execPath, [join(dir, "main.mjs"), releaseFile], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const logs: string[] = [];
    const replies: Record<string, unknown>[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => {
      logs.push(line);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      replies.push(JSON.parse(line) as Record<string, unknown>);
    });
    const exited = new Promise<number | null>((resolve) => {
      child.on("exit", resolve);
    });
    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    };
    send({
      id: 1,
      method: "initialize",
      params: { api: pluginApiVersion, plugin: manifest.id },
    });
    await until(() => replies.length === 2);
    expect(replies[0]).toMatchObject({ id: 1, result: {} });
    expect(replies[1]).toMatchObject({ method: "events.subscribe" });
    send({ id: replies[1]?.["id"], result: {} });
    send({ method: "event", params: { name: "demo.ping", data: "first" } });
    await until(() => logs.includes("first started"));
    send({ method: "shutdown" });
    send({ method: "event", params: { name: "demo.ping", data: "second" } });
    await later(100);
    expect(existsSync(releaseFile)).toBe(false);
    await writeFile(releaseFile, "");
    expect(await exited).toBe(0);
    return logs;
  } finally {
    child.kill("SIGKILL");
  }
}

describe("an SDK plugin at shutdown", () => {
  test("finishes a running handler, ignores a later event and cleans up last, on the test host and as its own program", async () => {
    const { folder: dir, shutdownPlugin } = await pluginFolder();
    const fake = await onTestHost(shutdownPlugin);
    const real = await asOwnProgram(dir);
    expect(fake).toEqual(expectedOrder);
    expect(real).toEqual(expectedOrder);
  }, 20_000);
});
