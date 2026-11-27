import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

const outcome = (attempt) => {
  try {
    attempt();
    return "ok";
  } catch (error) {
    return error.code ?? String(error);
  }
};

const leaf = () => readFileSync("/proc/self/cgroup", "utf8").trim().slice(3);

const inLeaf = () =>
  readFileSync(`/sys/fs/cgroup${leaf()}/cgroup.procs`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(Number);

const commandOf = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "";
  }
};

const pidsRunning = (needle) =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && commandOf(name).includes(needle))
    .map(Number);

function walk(folder, found) {
  found.push(folder);
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path, found);
    else found.push(path);
  }
}

function isolation() {
  const reached = [];
  const expect = (what, code) => {
    if (code !== "EACCES" && code !== "EPERM") reached.push(`${what}: ${code}`);
  };
  const paths = [];
  walk("/sys/fs/cgroup/bots", paths);
  for (const path of paths) {
    if (statSync(path).isDirectory()) {
      expect(
        `mkdir ${path}`,
        outcome(() => mkdirSync(join(path, "escape"))),
      );
    } else {
      expect(
        `write ${path}`,
        outcome(() => closeSync(openSync(path, constants.O_WRONLY))),
      );
    }
  }
  for (const role of ["bot-runner.js", "cgroup-supervisor.js"]) {
    const pids = pidsRunning(`/usr/local/lib/aphelion/${role}`);
    if (pids.length === 0) reached.push(`no ${role} process`);
    for (const pid of pids) {
      expect(
        `signal ${role}`,
        outcome(() => process.kill(pid, 0)),
      );
      expect(
        `stop ${role}`,
        outcome(() => process.kill(pid, "SIGSTOP")),
      );
    }
  }
  expect(
    "list /run/aphelion-runs",
    outcome(() => readdirSync("/run/aphelion-runs")),
  );
  return reached;
}

const daemons = `
sleep 600 &
setsid sleep 600 &
( setsid sh -c 'sleep 600 & exec sleep 600' & )
nohup setsid sh -c 'sleep 600 & wait' >/dev/null 2>&1 &
setsid sh -c 'while :; do ( setsid sleep 3 & ); sleep 0.05; done' >/dev/null 2>&1 &
`;

let seq = 0;
let initialized = null;
const event = (turn, body) => {
  seq += 1;
  send({ method: "event", params: { seq, turn, event: body } });
};

const report = (turn, extra) => {
  event(turn, {
    type: "text.delta",
    text: JSON.stringify({
      pid: process.pid,
      uid: process.getuid(),
      cwd: process.cwd(),
      env: process.env,
      leaf: leaf(),
      init: initialized,
      ...extra,
    }),
  });
};

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  switch (message.method) {
    case "initialize":
      initialized = message.params;
      send({ id: message.id, result: { api: "0.1.0", provider: "claude" } });
      break;
    case "turn.start": {
      const { turn, text } = message.params;
      send({ id: message.id, result: {} });
      if (text === "daemons") {
        event(null, {
          type: "session",
          ref: `contract-${initialized.bot.id}-1`,
        });
        spawn("sh", ["-c", daemons], { stdio: "ignore", detached: true });
        await sleep(500);
        const pids = inLeaf();
        const stable = pids.filter(
          (pid) =>
            pid === process.pid ||
            commandOf(pid) === "sleep\u0000600\u0000" ||
            commandOf(pid).includes("while :"),
        );
        report(turn, { pids, stable, reached: isolation() });
        event(turn, { type: "turn.end", reason: "completed" });
      } else if (text === "hang") {
        event(turn, { type: "text.delta", text: "{}" });
      } else {
        report(turn, {});
        event(turn, { type: "turn.end", reason: "completed" });
      }
      break;
    }
    case "turn.cancel":
      send({ id: message.id, result: {} });
      event(message.params.turn, { type: "turn.end", reason: "cancelled" });
      break;
    case "shutdown":
      send({ id: message.id, result: {} });
      process.exit(0);
  }
}
