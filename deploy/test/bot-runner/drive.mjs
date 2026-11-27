#!/usr/bin/env -S BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /usr/local/bin/bun
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

const say = (line) => process.stdout.write(`${line}\n`);
const fail = (why) => {
  say(`bot test FAIL: ${why}`);
  process.exit(1);
};
setTimeout(() => fail("it took longer than 150 seconds"), 150_000).unref();

const requests = createWriteStream(null, { fd: 6 });
const send = (frame) => requests.write(`${JSON.stringify(frame)}\n`);
const frames = [];
const events = { alpha: [], beta: [] };
let wake = () => undefined;
createInterface({ input: createReadStream(null, { fd: 5 }) }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.type === "event") events[frame.bot]?.push(frame.envelope);
  frames.push(frame);
  wake();
});
const next = async (match, what, seconds = 30) => {
  const until = Date.now() + seconds * 1000;
  for (;;) {
    const index = frames.findIndex(match);
    if (index >= 0) return frames.splice(index, 1)[0];
    const failed = frames.find(
      (frame) => frame.type === "start-failed" || frame.type === "exited",
    );
    if (failed) fail(`the runner sent ${JSON.stringify(failed)} while waiting for ${what}`);
    if (Date.now() > until) fail(`no ${what}`);
    await Promise.race([new Promise((done) => (wake = done)), sleep(100)]);
  }
};
const ofType = (type, bot) => (frame) => frame.type === type && frame.bot === bot;
const takeEvent = (bot, turn, type, what) =>
  next(
    (frame) =>
      frame.type === "event" &&
      frame.bot === bot &&
      frame.envelope.turn === turn &&
      frame.envelope.event.type === type,
    what,
  );

const checkpoint = async (name, lines) => {
  mkdirSync("/tmp/drive", { recursive: true });
  writeFileSync(`/tmp/drive/${name}`, `${lines.join("\n")}\n`);
  say(`checkpoint ${name}`);
  for (let tries = 0; tries < 600; tries++) {
    if (existsSync(`/tmp/drive/${name}.go`)) return;
    await sleep(100);
  }
  fail(`the test never let ${name} go on`);
};

const turn = async (bot, id, text) => {
  send({ type: "turn.start", bot, run: 1, turn: id, text });
  const answer = await next(
    (frame) =>
      (frame.type === "turn.accepted" || frame.type === "turn.refused") &&
      frame.bot === bot &&
      frame.turn === id,
    `an answer to turn ${id}`,
  );
  return answer.type === "turn.accepted" ? "accepted" : answer.reason;
};

const reportOf = async (bot, id) => {
  const delta = await takeEvent(bot, id, "text.delta", `${bot}'s report`);
  return JSON.parse(delta.envelope.event.text);
};
const ended = async (bot, id) => {
  const end = await takeEvent(bot, id, "turn.end", `the end of ${id}`);
  return end.envelope.event.reason;
};

const expectedEnv = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/var/lib/aphelion-bots",
  LANG: "C.UTF-8",
  TZ: "UTC",
  TMPDIR: "/tmp",
  DISABLE_AUTOUPDATER: "1",
};
const sorted = (env) => JSON.stringify(Object.entries(env).sort());

for (const bot of ["alpha", "beta"]) {
  send({
    type: "start",
    bot,
    run: 1,
    provider: "claude",
    adapter: "claude",
    folder: `/var/lib/aphelion-bots/${bot}`,
    resume: null,
  });
}
for (const bot of ["alpha", "beta"]) await next(ofType("started", bot), `${bot} started`, 60);

const first = {};
for (const bot of ["alpha", "beta"]) {
  if ((await turn(bot, `${bot}-1`, "daemons")) !== "accepted") fail(`${bot}'s first turn was refused`);
  const report = await reportOf(bot, `${bot}-1`);
  if ((await ended(bot, `${bot}-1`)) !== "completed") fail(`${bot}'s first turn didn't complete`);
  if (report.uid !== 10002) fail(`${bot} ran as uid ${report.uid}`);
  if (report.cwd !== `/var/lib/aphelion-bots/${bot}`) fail(`${bot} ran in ${report.cwd}`);
  if (sorted(report.env) !== sorted(expectedEnv)) fail(`${bot} got the environment ${JSON.stringify(report.env)}`);
  if (!/^\/bots\/work\/[0-9a-f-]{36}$/.test(report.leaf)) fail(`${bot} runs in ${report.leaf}`);
  if (report.reached.length > 0) fail(`${bot} reached ${report.reached.join(", ")}`);
  if (report.pids.length < 8) fail(`${bot}'s cgroup holds only ${report.pids.length} processes`);
  if (report.stable.length < 7) fail(`${bot} has ${report.stable.length} long-lived processes, not 7`);
  first[bot] = report;
}
if (first.alpha.leaf === first.beta.leaf) fail("both bots share a cgroup");
say(`isolation: each bot runs as aphelion-bot in its own cgroup and couldn't write the cgroup tree, list the run folders, or signal the runner or supervisor`);
await checkpoint("daemons", [
  `alive ${[...first.alpha.stable, ...first.beta.stable].join(" ")}`,
  `leaves ${first.alpha.leaf} ${first.beta.leaf}`,
]);

if ((await turn("alpha", "alpha-2", "hang")) !== "accepted") fail("alpha's hanging turn was refused");
await takeEvent("alpha", "alpha-2", "text.delta", "alpha's hanging turn");
send({ type: "turn.cancel", bot: "alpha", run: 1, turn: "alpha-2" });
const busy = await turn("alpha", "alpha-early", "whoami");
if (busy !== "busy") fail(`a turn during the cancel got ${busy}, not busy`);
if ((await ended("alpha", "alpha-2")) !== "cancelled") fail("the cancelled turn didn't end as cancelled");
let fresh;
for (let tries = 0; tries < 100 && fresh === undefined; tries++) {
  const id = `alpha-3-${tries}`;
  const answer = await turn("alpha", id, "whoami");
  if (answer === "accepted") {
    fresh = await reportOf("alpha", id);
    await ended("alpha", id);
  } else if (answer === "busy") {
    await sleep(100);
  } else {
    fail(`a turn after the cancel got ${answer}`);
  }
}
if (fresh === undefined) fail("alpha never took a turn after the cancel");
if (fresh.leaf === first.alpha.leaf || fresh.pid === first.alpha.pid) fail("the cancel didn't start a fresh adapter in a new cgroup");
if (fresh.init?.resume !== "contract-alpha-1") fail(`the fresh adapter resumed ${fresh.init?.resume}`);
say("cancel: alpha's turn ended as cancelled, a turn during the cancel was refused as busy, and a fresh adapter in a new cgroup resumed the session");
await checkpoint("cancelled", [
  `gone ${first.alpha.pids.join(" ")}`,
  `alive ${first.beta.stable.join(" ")} ${fresh.pid}`,
  `leaves ${fresh.leaf} ${first.beta.leaf}`,
  `removed ${first.alpha.leaf}`,
]);

for (const bot of ["alpha", "beta"]) send({ type: "stop", bot, run: 1 });
for (const bot of ["alpha", "beta"]) await next(ofType("stopped", bot), `${bot} stopped`);
say("stop: both bots stopped");
await checkpoint("stopped", [
  `gone ${first.beta.pids.join(" ")} ${fresh.pid}`,
  `removed ${fresh.leaf} ${first.beta.leaf}`,
]);

const seqs = events.alpha.map((envelope) => envelope.seq);
if (seqs.some((seq, index) => seq !== index + 1)) fail(`alpha's events came as seq ${seqs.join(",")}`);
say("bot test passed");
process.exit(0);
