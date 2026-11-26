import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers";

const adapter = join(import.meta.dirname, "fake-adapter.mjs");
const folder = "/var/lib/aphelion-bots/contract-bot";
const runner = spawn(
  "/usr/local/bin/bun",
  [
    "/usr/local/lib/aphelion/bot-runner.js",
    "--bun",
    "/usr/local/bin/bun",
    "--home",
    "/var/lib/aphelion-bots",
  ],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      HTTPS_PROXY: "http://proxy.invalid:3128",
      NO_PROXY: "localhost",
    },
  },
);

const fail = (why) => {
  process.stderr.write(`bot runner check failed: ${why}\n`);
  runner.kill("SIGKILL");
  process.exit(1);
};
setTimeout(() => fail("it took longer than 20 seconds"), 20_000).unref();

const frames = createInterface({ input: runner.stdout })[
  Symbol.asyncIterator
]();
const next = async (type) => {
  for (;;) {
    const { value, done } = await frames.next();
    if (done) fail(`the runner closed its output before ${type}`);
    const frame = JSON.parse(value);
    if (frame.bot !== "contract-bot") fail(`a frame names ${frame.bot}`);
    if (frame.type === type) return frame;
    if (frame.type === "start-failed" || frame.type === "exited") {
      fail(`the runner sent ${value}`);
    }
  }
};
const send = (frame) => runner.stdin.write(`${JSON.stringify(frame)}\n`);

send({
  type: "start",
  bot: "contract-bot",
  run: 1,
  provider: "claude",
  adapter,
  folder,
  resume: null,
});
await next("started");
send({
  type: "turn.start",
  bot: "contract-bot",
  run: 1,
  turn: "contract-turn",
  text: "report",
});
await next("turn.accepted");
const events = [];
for (;;) {
  const { envelope } = await next("event");
  events.push(envelope);
  if (envelope.event.type === "turn.end") break;
}
send({ type: "stop", bot: "contract-bot", run: 1 });
await next("stopped");
runner.stdin.end();

const seqs = events.map((envelope) => envelope.seq).join(",");
if (seqs !== "1,2,3") fail(`the events came as seq ${seqs}`);
const report = JSON.parse(events[1].event.text);
const expected = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/var/lib/aphelion-bots",
  LANG: "C.UTF-8",
  TZ: "UTC",
  TMPDIR: "/tmp",
  DISABLE_AUTOUPDATER: "1",
};
const sorted = (env) => JSON.stringify(Object.entries(env).sort());
if (sorted(report.env) !== sorted(expected)) {
  fail(`the bot got the environment ${JSON.stringify(report.env)}`);
}
if (report.bot !== "contract-bot") fail(`the bot was told it is ${report.bot}`);
if (report.uid !== 10002) fail(`the bot ran as uid ${report.uid}`);
if (report.cwd !== folder) fail(`the bot ran in ${report.cwd}`);
if (report.runnerFd !== "EACCES" || report.runnerEnviron !== "EACCES") {
  fail(
    `the bot reached the runner's fds (${report.runnerFd}) or environment (${report.runnerEnviron})`,
  );
}
process.stdout.write("bot runner check passed\n");
