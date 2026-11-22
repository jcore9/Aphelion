import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, type Scope } from "effect";
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
const uid = process.getuid?.() ?? 0;
const isRoot = uid === 0;

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
    else if (entry.isFile()) {
      await chmod(child, mode === "read-only" ? 0o444 : 0o644);
    }
  }
  await chmod(path, mode === "read-only" ? 0o555 : 0o755);
}

async function installPlugin(folder: string, id: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "index.js"), pluginSource);
  await writeFile(join(folder, ".env"), "APHELION_DOTENV=leaked\n");
  await writeFile(
    join(folder, "aphelion-plugin.json"),
    JSON.stringify({
      id,
      version: "1.0.0",
      api: "^0.2.0",
      server: { entry: "index.js" },
      permissions: { events: ["agent.status"] },
    }),
  );
}

type Launch = "as the plugin user" | "as another user";

function runnerArguments(launch: Launch, dataRoot: string): string[] {
  if (launch === "as the plugin user") {
    return [runnerMain, "--bun", process.execPath, "--data", dataRoot];
  }
  const options = { bun: process.execPath, data: dataRoot, pluginUid: uid + 1 };
  return [
    "-e",
    `import { serveRunner } from ${JSON.stringify(runnerMain)};
await serveRunner(${JSON.stringify(options)});
process.exit(0);`,
  ];
}

const testFolder = Effect.gen(function* () {
  const base = yield* Effect.promise(() =>
    mkdtemp(join(tmpdir(), "aphelion-runner-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await setPermissions(base, "writable").catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }),
  );
  return base;
});

const startRunner = (
  launch: Launch,
  dataRoot: string,
  logs: Record<string, unknown>[],
  canary: string,
): Effect.Effect<
  { host: Context.Service.Shape<typeof PluginHost>; runnerPid: number },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const runner = spawn(process.execPath, runnerArguments(launch, dataRoot), {
      env: { ...process.env, APHELION_CANARY: canary },
      stdio: ["pipe", "pipe", "inherit"],
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise<void>((done) => {
            if (runner.exitCode !== null) {
              done();
              return;
            }
            const timer = setTimeout(() => {
              runner.kill("SIGKILL");
              done();
            }, 5_000);
            runner.once("exit", () => {
              clearTimeout(timer);
              done();
            });
            runner.stdin.end();
          }),
      ),
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
    return {
      host: Context.get(services, PluginHost),
      runnerPid: runner.pid ?? 0,
    };
  });

const refusal = (logs: Record<string, unknown>[], plugin: string) =>
  logs.find(
    (log) =>
      log["msg"] === "plugin runner couldn't start the plugin" &&
      log["plugin"] === plugin,
  )?.["reason"];

describe.skipIf(process.platform !== "linux" || isRoot)(
  "the plugin runner process",
  () => {
    it.live(
      "runs a real plugin, keeps its folder read-only and its environment clean, and kills its whole tree",
      () => {
        const canary = `canary-${crypto.randomUUID()}`;
        const logs: Record<string, unknown>[] = [];
        return Effect.gen(function* () {
          const base = yield* testFolder;
          const installed = join(base, "installed");
          const folder = join(installed, "sampler");
          const dataRoot = join(base, "data");
          yield* Effect.promise(async () => {
            await installPlugin(folder, "sampler");
            await installPlugin(join(installed, "careless"), "careless");
            await installPlugin(join(installed, "linked"), "linked");
            await installPlugin(join(installed, "borrower"), "borrower");
            await installPlugin(join(base, "outside"), "outside");
            await installPlugin(join(base, "loose", "exposed"), "exposed");
            await rm(join(installed, "linked", "index.js"));
            await symlink(
              join(base, "outside", "index.js"),
              join(installed, "linked", "index.js"),
            );
            await symlink(
              join(base, "outside", "index.js"),
              join(installed, "borrower", "lib.js"),
            );
            await mkdir(dataRoot);
            await setPermissions(installed, "read-only");
            await setPermissions(join(base, "outside"), "read-only");
            await setPermissions(join(base, "loose", "exposed"), "read-only");
            await setPermissions(join(installed, "careless"), "writable");
            await chmod(base, 0o555);
          });
          const { host, runnerPid } = yield* startRunner(
            "as another user",
            dataRoot,
            logs,
            canary,
          );

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
          expect(report.env).not.toHaveProperty("APHELION_DOTENV");
          expect(JSON.stringify(report.env)).not.toContain(canary);
          expect(() => readlinkSync(`/proc/${String(runnerPid)}/fd/0`)).toThrow(
            expect.objectContaining({ code: "EACCES" }),
          );

          yield* host.stop("sampler");
          yield* poll(host.status("sampler"), (s) => s?.state === "stopped");
          expect(
            yield* poll(Effect.sync(sleepers), (count) => count === 0),
          ).toBe(0);

          for (const plugin of ["careless", "linked", "borrower"]) {
            yield* host.start(join(installed, plugin));
            yield* poll(host.status(plugin), (s) => s?.state === "crashed");
          }
          yield* host.start(join(base, "loose", "exposed"));
          yield* poll(host.status("exposed"), (s) => s?.state === "crashed");
          expect(refusal(logs, "exposed")).toBe(
            "the plugin user can change a folder above the plugin's folder",
          );
          expect(refusal(logs, "careless")).toBe(
            "the plugin user can write to the plugin's folder",
          );
          expect(refusal(logs, "linked")).toBe(
            "the entry is outside the plugin's folder",
          );
          expect(refusal(logs, "borrower")).toBe(
            "a link in the plugin's folder points outside it",
          );
        }).pipe(Effect.scoped);
      },
      30_000,
    );

    it.live(
      "refuses a plugin whose files the plugin user owns, even when they are read-only",
      () => {
        const logs: Record<string, unknown>[] = [];
        return Effect.gen(function* () {
          const base = yield* testFolder;
          const folder = join(base, "installed", "sampler");
          yield* Effect.promise(async () => {
            await installPlugin(folder, "sampler");
            await setPermissions(folder, "read-only");
          });
          const { host } = yield* startRunner(
            "as the plugin user",
            join(base, "data"),
            logs,
            "unused",
          );
          yield* host.start(folder);
          yield* poll(host.status("sampler"), (s) => s?.state === "crashed");
          expect(refusal(logs, "sampler")).toBe(
            "the plugin user owns a file in the plugin's folder",
          );
          expect(sleepers()).toBe(0);
        }).pipe(Effect.scoped);
      },
      30_000,
    );
  },
);
