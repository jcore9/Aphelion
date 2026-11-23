import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pluginApiVersion } from "../packages/plugin-sdk/src/index.ts";

const folder = process.argv[2];
if (folder === undefined) {
  console.error("usage: bun scripts/check-plugin-bundle.ts <plugin folder>");
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(join(folder, "aphelion-plugin.json"), "utf8"),
) as { id: string; server: { entry: string } };
const data = mkdtempSync(join(tmpdir(), "aphelion-plugin-data-"));

const plugin = spawn(
  process.execPath,
  ["--no-env-file", manifest.server.entry],
  {
    cwd: folder,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: data,
      LANG: "C.UTF-8",
      APHELION_PLUGIN_ID: manifest.id,
      APHELION_PLUGIN_DATA: data,
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

type Message = Record<string, unknown>;
const messages: Message[] = [];
const logs: string[] = [];
const waiters = new Set<() => void>();
const changed = () => {
  for (const wake of waiters) wake();
};
createInterface({ input: plugin.stdout }).on("line", (line) => {
  messages.push(JSON.parse(line) as Message);
  changed();
});
createInterface({ input: plugin.stderr }).on("line", (line) => {
  logs.push(line);
  changed();
});
const exited = new Promise<number | null>((resolve) => {
  plugin.on("exit", (code) => {
    resolve(code);
  });
});

function until<T>(what: string, find: () => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(check);
      reject(
        new Error(`timed out waiting for ${what}; logs: ${logs.join(" | ")}`),
      );
    }, 5000);
    function check() {
      const found = find();
      if (found === undefined) return;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(found);
    }
    waiters.add(check);
    check();
  });
}

const send = (message: Message) => {
  plugin.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

try {
  send({
    id: 1,
    method: "initialize",
    params: { api: pluginApiVersion, plugin: manifest.id },
  });
  const reply = await until("the initialize reply", () =>
    messages.find((message) => message["id"] === 1),
  );
  if (JSON.stringify(reply["result"]) !== "{}") {
    throw new Error(`unexpected initialize reply ${JSON.stringify(reply)}`);
  }
  const subscribe = await until("events.subscribe", () =>
    messages.find((message) => message["method"] === "events.subscribe"),
  );
  send({ id: subscribe["id"], result: {} });
  await until("the startup line", () =>
    logs.find((line) => line === "plugin started"),
  );
  send({
    method: "event",
    params: { name: "approval.requested", data: { tool: "shell" } },
  });
  await until("the event's log line", () =>
    logs.find((line) => line === 'an approval was requested: {"tool":"shell"}'),
  );
  send({ method: "shutdown" });
  const code = await Promise.race([
    exited,
    new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve("still running");
      }, 5000),
    ),
  ]);
  if (code !== 0) throw new Error(`the plugin exited with ${String(code)}`);
  console.log(
    `${manifest.id} answered initialize, handled an event and exited cleanly`,
  );
} catch (error) {
  plugin.kill("SIGKILL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  rmSync(data, { recursive: true, force: true });
}
