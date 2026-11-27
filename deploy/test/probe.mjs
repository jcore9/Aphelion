import {
  readdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import process from "node:process";

const roles = {
  server: "/usr/local/bin/aphelion --headless",
  runner: "/usr/local/lib/aphelion/plugin-runner.js",
  botRunner: "/usr/local/lib/aphelion/bot-runner.js",
  supervisor: "/usr/local/lib/aphelion/cgroup-supervisor.js",
  broker: "/usr/local/bin/aphelion-secrets",
};

function pidOf(role) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (command.replaceAll("\0", " ").includes(roles[role])) {
        return Number(entry);
      }
    } catch {
      continue;
    }
  }
  throw new Error(`no ${role} process`);
}

function resolve(target) {
  return target.replace(/\{(\w+)\}/g, (_, role) => String(pidOf(role)));
}

const operations = {
  list: (path) => readdirSync(path),
  read: (path) => readFileSync(path),
  readlink: (path) => readlinkSync(path),
  write: (path) => {
    const file = `${path}/.probe-${String(process.pid)}`;
    writeFileSync(file, "probe");
    unlinkSync(file);
  },
  signal: (pid) => process.kill(Number(pid), 0),
  connect: (path) =>
    new Promise((done, fail) => {
      const socket = createConnection(path);
      socket.on("connect", () => {
        socket.destroy();
        done();
      });
      socket.on("error", fail);
    }),
};

export async function runChecks(checks) {
  const failures = [];
  for (const [operation, target, expected] of checks) {
    const path = resolve(target);
    let outcome = "ok";
    try {
      await operations[operation](path);
    } catch (error) {
      outcome = error.code ?? String(error);
    }
    if (outcome !== expected) {
      failures.push(
        `${operation} ${path}: got ${outcome}, expected ${expected}`,
      );
    }
  }
  return failures;
}

export function inheritedPipes() {
  return readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("aphelion-launch")
        ? [`fd ${fd} -> ${target}`]
        : [];
    } catch {
      return [];
    }
  });
}

if (import.meta.main) {
  const failures = await runChecks(JSON.parse(process.argv[2]));
  for (const failure of failures) process.stdout.write(`${failure}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
