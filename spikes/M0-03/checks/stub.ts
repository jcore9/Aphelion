// Container stub for M0-03. Throwaway spike code; never merged.
// stub server   -> HTTP /health on :7400, logs its uid
// stub idle     -> logs its uid and stays up (broker, runners)
// stub launch   -> variant B init: starts the four roles as four users with spawn({uid, gid})
// stub probe    -> isolation checks, run as aphelion-agent
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const role = process.argv[2];
const name = process.argv[3] ?? role;
const who = () => `${name} uid=${process.getuid!()} gid=${process.getgid!()}`;

if (role === "server") {
  createServer((req, res) => {
    if (req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    res.writeHead(404).end();
  }).listen(7400, "0.0.0.0", () => {
    console.log(`${who()} listening on :7400 groups=${process.getgroups!().join(",")}`);
    try {
      readdirSync("/var/lib/aphelion-agents");
      console.log("server: can list agent folders");
    } catch (e) {
      console.log(`server: cannot list agent folders (${(e as NodeJS.ErrnoException).code})`);
    }
  });
} else if (role === "broker") {
  const secret = readFileSync(0);
  console.log(`${who()} got bootstrap secret on stdin (${secret.length} bytes)`);
  setInterval(() => {}, 1 << 30);
} else if (role === "idle") {
  console.log(`${who()} up`);
  setInterval(() => {}, 1 << 30);
} else if (role === "launch") {
  const users: Array<[string, number, string[]]> = [
    ["harness", 10001, ["server", "server"]],
    ["aphelion-secrets", 10003, ["idle", "broker"]],
    ["aphelion-agent", 10002, ["idle", "agent-runner"]],
    ["aphelion-plugins", 10004, ["idle", "plugin-runner"]],
  ];
  for (const [user, id, args] of users) {
    const child = spawn(process.execPath, args, { uid: id, gid: id, stdio: "inherit" });
    child.on("exit", (code) => console.log(`launcher: ${user} exited ${code}`));
  }
  console.log(`launcher ${who()} started ${users.length} children`);
} else if (role === "probe") {
  const tryIt = (label: string, fn: () => unknown) => {
    try {
      fn();
      console.log(`ALLOWED  ${label}`);
    } catch (e) {
      console.log(`DENIED   ${label} (${(e as NodeJS.ErrnoException).code})`);
    }
  };
  console.log(who());
  tryIt("list /etc/aphelion", () => readdirSync("/etc/aphelion"));
  tryIt("list /var/lib/aphelion", () => readdirSync("/var/lib/aphelion"));
  tryIt("list /var/lib/aphelion-secrets", () => readdirSync("/var/lib/aphelion-secrets"));
  tryIt("read /run/secrets/bootstrap", () => readFileSync("/run/secrets/bootstrap"));
  tryIt("write /etc/claude-code/managed-settings.json", () => writeFileSync("/etc/claude-code/managed-settings.json", "{}"));
  tryIt("write /usr/local/bin/x", () => writeFileSync("/usr/local/bin/x", ""));
  tryIt("write own agent folder", () => writeFileSync("/var/lib/aphelion-agents/probe.txt", "ok"));
  tryIt("write /tmp", () => writeFileSync("/tmp/probe.txt", "ok"));
  tryIt("setuid to harness (process.setuid)", () => process.setuid!(10001));
}
