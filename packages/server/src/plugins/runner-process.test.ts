import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { describe } from "vitest";
import { createLogger } from "../log";
import { PluginGrants, PluginHost, pluginHostLayer, RunnerLink } from "./host";
import { pipeLink } from "./link";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

const sleepSeconds = String(5000 + Math.floor(Math.random() * 4000));

const pluginSource = `
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const data = process.env.APHELION_PLUGIN_DATA;
const sh = (script) => spawn("sh", ["-c", script], { stdio: "ignore" });
sh("sleep ${sleepSeconds}");
sh("setsid sh -c 'sleep ${sleepSeconds} & sleep ${sleepSeconds}'");
sh("(setsid sh -c 'sleep ${sleepSeconds} &' &)");
sh("nohup sleep ${sleepSeconds} >/dev/null 2>&1 &");

const attempt = (change) => {
  try { change(); return "changed"; } catch (error) { return error.code; }
};
writeFileSync(data + "/report.json", JSON.stringify({
  env: process.env,
  ownFile: attempt(() => appendFileSync(new URL("./index.js", import.meta.url), "//")),
  newFile: attempt(() => writeFileSync(new URL("./added.js", import.meta.url), "")),
}));

const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    send({ jsonrpc: "2.0", id: "sub", method: "events.subscribe", params: { event: "agent.status" } });
  } else if (message.id === "sub") {
    appendFileSync(data + "/received.jsonl", line + "\\n");
  } else if (message.method === "event") {
    appendFileSync(data + "/received.jsonl", line + "\\n");
  }
}
`;

const runnerMain = join(import.meta.dirname, "runner-main.ts");
const isRoot = process.getuid?.() === 0;

function sleepers(): number {
  let count = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (command === `sleep\0${sleepSeconds}\0`) count++;
    } catch {
      continue;
    }
  }
  return count;
}

const poll = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    let value = yield* read;
    for (let tries = 0; tries < 400 && !done(value); tries++) {
      yield* Effect.sleep("25 millis");
      value = yield* read;
    }
    return value;
  });

const textOf = (path: string) =>
  Effect.promise(() => readFile(path, "utf8").catch(() => ""));

async function setPermissions(path: string, mode: "read-only" | "writable") {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await setPermissions(child, mode);
    else await chmod(child, mode === "read-only" ? 0o444 : 0o644);
  }
  await chmod(path, mode === "read-only" ? 0o555 : 0o755);
}

describe.skipIf(process.platform !== "linux" || isRoot)(
  "the plugin runner process",
  () => {
    it.live(
      "runs a real plugin, keeps its folder read-only and its environment clean, and kills its whole tree",
      () => {
        const canary = `canary-${crypto.randomUUID()}`;
        const logs: Record<string, unknown>[] = [];
        return Effect.gen(function* () {
          const base = yield* Effect.promise(() =>
            mkdtemp(join(tmpdir(), "aphelion-runner-")),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              await setPermissions(base, "writable").catch(() => undefined);
              await rm(base, { recursive: true, force: true });
            }),
          );
          const folder = join(base, "installed", "sampler");
          const writableFolder = join(base, "installed", "careless");
          const dataRoot = join(base, "data");
          for (const [path, id] of [
            [folder, "sampler"],
            [writableFolder, "careless"],
          ] as const) {
            yield* Effect.promise(async () => {
              await mkdir(path, { recursive: true });
              await writeFile(join(path, "index.js"), pluginSource);
              await writeFile(
                join(path, "aphelion-plugin.json"),
                JSON.stringify({
                  id,
                  version: "1.0.0",
                  api: "^0.2.0",
                  server: { entry: "index.js" },
                  permissions: { events: ["agent.status"] },
                }),
              );
            });
          }
          yield* Effect.promise(() => setPermissions(folder, "read-only"));

          const runner = spawn(
            process.execPath,
            [runnerMain, "--bun", process.execPath, "--data", dataRoot],
            {
              env: { ...process.env, APHELION_CANARY: canary },
              stdio: ["pipe", "pipe", "inherit"],
            },
          );
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => runner.kill("SIGKILL")),
          );
          const link = yield* pipeLink(
            Readable.toWeb(runner.stdout) as ReadableStream<Uint8Array>,
            (text) =>
              new Promise((done) => {
                runner.stdin.write(text, () => {
                  done(undefined);
                });
              }),
            {
              schema: runnerReplySchema,
              maxBytes: maxFrameBytes,
              onDrop: () => Effect.void,
            },
            runnerRequestSchema,
          );
          const services = yield* Layer.build(
            pluginHostLayer({
              logger: createLogger({
                write: (line) =>
                  logs.push(JSON.parse(line) as Record<string, unknown>),
              }),
              policy: {
                handshakeMs: 10_000,
                graceMs: 200,
                firstRetryMs: 10_000,
                maxRetryMs: 10_000,
                maxCrashes: 1,
                stableMs: 60_000,
              },
            }).pipe(
              Layer.provide(Layer.succeed(RunnerLink, link)),
              Layer.provide(
                Layer.succeed(PluginGrants, {
                  allows: () => Effect.succeed(true),
                }),
              ),
            ),
          );
          const host = Context.get(services, PluginHost);

          yield* host.start(folder);
          yield* poll(host.status("sampler"), (s) => s?.state === "running");
          expect(
            yield* poll(Effect.sync(sleepers), (count) => count === 5),
          ).toBe(5);

          const received = join(dataRoot, "sampler", "received.jsonl");
          yield* poll(textOf(received), (text) => text.includes('"id":"sub"'));
          yield* host.publish({ name: "agent.status", data: { busy: true } });
          const lines = yield* poll(textOf(received), (text) =>
            text.includes('"event"'),
          );
          expect(lines).toContain(
            '"params":{"name":"agent.status","data":{"busy":true}}',
          );

          const report = JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(dataRoot, "sampler", "report.json"), "utf8"),
            ),
          ) as {
            env: Record<string, string>;
            ownFile: string;
            newFile: string;
          };
          expect(report.ownFile).toBe("EACCES");
          expect(report.newFile).toBe("EACCES");
          expect(report.env).toMatchObject({
            APHELION_PLUGIN_ID: "sampler",
            HOME: join(dataRoot, "sampler"),
          });
          expect(JSON.stringify(report.env)).not.toContain(canary);

          yield* host.stop("sampler");
          yield* poll(host.status("sampler"), (s) => s?.state === "stopped");
          expect(
            yield* poll(Effect.sync(sleepers), (count) => count === 0),
          ).toBe(0);

          yield* host.start(writableFolder);
          yield* poll(host.status("careless"), (s) => s?.state === "crashed");
          expect(logs).toContainEqual(
            expect.objectContaining({
              plugin: "careless",
              reason: "the plugin user can write to the plugin's folder",
            }),
          );
        }).pipe(Effect.scoped);
      },
      30_000,
    );
  },
);
