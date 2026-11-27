import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  write,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { checkStream } from "@aphelion/plugin-sdk/testing";
import { expect, it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { describe } from "vitest";
import { freezeAndKill, read } from "../adapters/process-tree";
import {
  maxSupervisorFrameBytes,
  supervisorReplySchema,
  supervisorRequestSchema,
  type SupervisorReply,
  type SupervisorRequest,
} from "../cgroups/protocol";
import { pipeLink, type Link } from "../plugins/link";
import { botEnvironment } from "./environment";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequest,
} from "./runner-protocol";

const sdk = join(import.meta.dirname, "../../../../packages/plugin-sdk/src");
const runnerMain = join(import.meta.dirname, "runner-main.ts");
const launcher = join(import.meta.dirname, "../adapters/adapter-launcher.ts");
const sleepSeconds = String(5000 + Math.floor(Math.random() * 4000));
const isRoot = (process.getuid?.() ?? 0) === 0;

const adapterSource = (stubborn: boolean) => `
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { runAdapter } from ${JSON.stringify(join(sdk, "adapter-runtime.ts"))};
import { readLines } from ${JSON.stringify(join(sdk, "lines.ts"))};
import { mainAdapter } from ${JSON.stringify(join(sdk, "stdio.ts"))};
import { fakeAdapter } from ${JSON.stringify(join(sdk, "testing.ts"))};

const attempt = (read) => {
  try { read(); return "ok"; } catch (error) { return error.code; }
};
const runnerPid = readdirSync("/proc").find((name) => {
  try {
    return /^\\d+$/.test(name) && readFileSync("/proc/" + name + "/cmdline", "utf8").includes(${JSON.stringify(runnerMain)});
  } catch {
    return false;
  }
});
const fds = readdirSync("/proc/self/fd").map((fd) => {
  try {
    const info = statSync("/proc/self/fd/" + fd);
    return [info.dev, info.ino];
  } catch {
    return [0, 0];
  }
});
spawn("sh", ["-c", "sleep ${sleepSeconds} & setsid sleep ${sleepSeconds} & sleep ${sleepSeconds}"], { stdio: "ignore" });
const report = JSON.stringify({
  pid: process.pid,
  fds,
  env: process.env,
  cwd: process.cwd(),
  runnerFd: attempt(() => readlinkSync("/proc/" + runnerPid + "/fd/0")),
  runnerEnviron: attempt(() => readFileSync("/proc/" + runnerPid + "/environ")),
});
const adapter = fakeAdapter([
  [{ emit: { type: "text.delta", text: report } }, { emit: { type: "turn.end", reason: "completed" } }],
  [{ hang: true }],
], "claude");
if (${String(stubborn)}) {
  const write = (line) => new Promise((done) => process.stdout.write(line + "\\n", () => done()));
  await runAdapter(adapter, { input: readLines(process.stdin, () => undefined), write, log: () => undefined });
  setInterval(() => undefined, 1000);
} else {
  mainAdapter(adapter);
}
`;

function sleepers(): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (command === `sleep\0${sleepSeconds}\0`) found.push(Number(name));
    } catch {
      continue;
    }
  }
  return found;
}

const attempt = (read: () => unknown) => {
  try {
    read();
    return "ok";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

const poll = <A>(read: () => A, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    let value = read();
    for (let tries = 0; tries < 200 && !done(value); tries++) {
      yield* Effect.sleep("25 millis");
      value = read();
    }
    return value;
  });

const fifo = (path: string) => {
  spawnSync("mkfifo", ["-m", "0600", path]);
  const hold = openSync(path, "r+");
  const reader = openSync(path, "r");
  const writer = openSync(path, "w");
  closeSync(hold);
  const { dev, ino } = fstatSync(reader);
  return { reader, writer, dev, ino };
};

const testSupervisor = (
  link: Link<SupervisorRequest, SupervisorReply>,
  base: string,
  adapters: Readonly<Record<string, string>>,
  home: string,
) =>
  Effect.gen(function* () {
    const children = new Map<string, ChildProcess>();
    yield* link.send({ type: "ready" });
    const handle = (request: SupervisorRequest) =>
      Effect.promise(async () => {
        if (request.type === "start") {
          const folder = join(base, "runs", request.run);
          await mkdir(folder, { recursive: true });
          const paths = ["stdin", "stdout", "stderr"].map((name) =>
            join(folder, name),
          );
          spawnSync("mkfifo", ["-m", "0600", ...paths]);
          const child = spawn(
            "sh",
            [
              "-c",
              'exec 1>"$1/stdout" 2>"$1/stderr" 0<"$1/stdin"; unset PWD; exec "$2" --no-env-file --preload "$3" "$4" "$5"',
              "sh",
              folder,
              process.execPath,
              launcher,
              adapters[request.adapter] ?? "",
              request.bot,
            ],
            { stdio: "ignore", env: botEnvironment("claude", home) },
          );
          children.set(request.run, child);
          child.once("exit", (code, signal) => {
            void Effect.runPromise(
              link.send({ type: "exited", run: request.run, code, signal }),
            );
          });
          await Effect.runPromise(
            link.send({
              type: "started",
              run: request.run,
              stdin: paths[0] ?? "",
              stdout: paths[1] ?? "",
              stderr: paths[2] ?? "",
            }),
          );
          return;
        }
        const child = children.get(request.run);
        const root = child?.pid === undefined ? undefined : read(child.pid);
        freezeAndKill(() => (root ? [root] : []));
        for (const pid of sleepers()) process.kill(pid, "SIGKILL");
        await Effect.runPromise(
          link.send({ type: "killed", run: request.run }),
        );
      });
    yield* Queue.take(link.incoming).pipe(
      Effect.flatMap(handle),
      Effect.forever,
      Effect.ignore,
      Effect.forkScoped,
    );
  });

const startRunner = Effect.gen(function* () {
  const base = yield* Effect.promise(() =>
    mkdtemp(join(tmpdir(), "aphelion-bot-runner-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const pid of sleepers()) process.kill(pid, "SIGKILL");
      await rm(base, { recursive: true, force: true });
    }),
  );
  const adapters = {
    plain: join(base, "adapter.mjs"),
    stubborn: join(base, "stubborn.mjs"),
  };
  yield* Effect.promise(async () => {
    await writeFile(adapters.plain, adapterSource(false));
    await writeFile(adapters.stubborn, adapterSource(true));
  });
  const requests = fifo(join(base, "requests"));
  const replies = fifo(join(base, "replies"));
  const supRequests = fifo(join(base, "sup-requests"));
  const supReplies = fifo(join(base, "sup-replies"));
  const home = join(base, "home");
  const runner = spawn(
    process.execPath,
    [runnerMain, "--supervisor-fds", "3,4"],
    {
      stdio: [
        requests.reader,
        replies.writer,
        "inherit",
        supReplies.reader,
        supRequests.writer,
      ],
      env: { ...process.env, HTTPS_PROXY: "http://proxy.test:3128" },
    },
  );
  for (const fd of [
    requests.reader,
    replies.writer,
    supReplies.reader,
    supRequests.writer,
  ]) {
    closeSync(fd);
  }
  const supervisorLink = yield* pipeLink(
    Readable.toWeb(
      createReadStream("", { fd: supRequests.reader }),
    ) as ReadableStream<Uint8Array>,
    (text) =>
      new Promise((done) => {
        write(supReplies.writer, text, () => {
          done(undefined);
        });
      }),
    {
      schema: supervisorRequestSchema,
      maxBytes: maxSupervisorFrameBytes,
      onDrop: () => Effect.void,
    },
    supervisorReplySchema,
  );
  yield* testSupervisor(supervisorLink, base, adapters, home);
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((done) => {
          const timer = setTimeout(() => {
            runner.kill("SIGKILL");
            done();
          }, 5_000);
          runner.once("exit", () => {
            clearTimeout(timer);
            done();
          });
          closeSync(requests.writer);
          if (runner.exitCode !== null) done();
        }),
    ),
  );
  const link = yield* pipeLink(
    Readable.toWeb(
      createReadStream("", { fd: replies.reader }),
    ) as ReadableStream<Uint8Array>,
    (text) =>
      new Promise((done) => {
        write(requests.writer, text, () => {
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
  const frames: RunnerReply[] = [];
  const until = (done: (frame: RunnerReply) => boolean) =>
    Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(link.incoming);
        frames.push(frame);
        if (done(frame)) return frame;
      }
    }).pipe(Effect.timeout("20 seconds"), Effect.orDie);
  const send = (frame: RunnerRequest) => link.send(frame);
  const start = (run: number, adapter: keyof typeof adapters = "plain") =>
    send({
      type: "start",
      bot: "alpha",
      run,
      provider: "claude",
      adapter,
      folder: join(home, "alpha"),
      resume: null,
    });
  const turn = (run: number, id: string) =>
    send(
      runnerRequestSchema.parse({
        type: "turn.start",
        bot: "alpha",
        run,
        turn: id,
        text: "report",
      }),
    );
  return {
    base,
    home,
    requests,
    replies,
    supRequests,
    supReplies,
    frames,
    until,
    start,
    turn,
    send,
  };
});

const is = (type: RunnerReply["type"]) => (frame: RunnerReply) =>
  frame.type === type;

describe.skipIf(process.platform !== "linux" || isRoot)(
  "the bot runner process",
  () => {
    it.live(
      "gives a bot only its own environment and standard streams, hides its pipes, and kills the tree of a bot that ignores shutdown",
      () =>
        Effect.gen(function* () {
          const runner = yield* startRunner;
          yield* runner.start(1, "stubborn");
          yield* runner.until(is("started"));
          expect(existsSync(join(runner.home, "alpha"))).toBe(true);
          yield* runner.turn(1, "t1");
          const delta = yield* runner.until(
            (frame) =>
              frame.type === "event" &&
              frame.envelope.event.type === "text.delta",
          );
          const event = delta.type === "event" ? delta.envelope.event : null;
          const report = JSON.parse(
            event?.type === "text.delta" ? event.text : "{}",
          ) as {
            pid: number;
            fds: [number, number][];
            env: Record<string, string>;
            cwd: string;
            runnerFd: string;
            runnerEnviron: string;
          };
          expect(report.env).toEqual(botEnvironment("claude", runner.home));
          expect(report.cwd).toBe(join(runner.home, "alpha"));
          const pipes = [
            runner.requests,
            runner.replies,
            runner.supRequests,
            runner.supReplies,
          ].map(({ dev, ino }) => `${String(dev)}:${String(ino)}`);
          const held = report.fds.map(
            ([dev, ino]) => `${String(dev)}:${String(ino)}`,
          );
          expect(held.filter((fd) => pipes.includes(fd))).toEqual([]);
          expect(report.runnerFd).toBe("EACCES");
          expect(report.runnerEnviron).toBe("EACCES");
          expect(
            attempt(() => readdirSync(`/proc/${String(report.pid)}/fd`)),
          ).toBe("EACCES");
          expect(
            attempt(() => readdirSync(`/proc/${String(process.pid)}/fd`)),
          ).toBe("ok");

          expect(
            yield* poll(
              () => sleepers().length,
              (n) => n === 3,
            ),
          ).toBe(3);
          yield* runner.send({ type: "stop", bot: "alpha", run: 1 });
          yield* runner.until(is("stopped"));
          expect(
            yield* poll(
              () => sleepers().length,
              (n) => n === 0,
            ),
          ).toBe(0);
        }).pipe(Effect.scoped),
      30_000,
    );

    it.live(
      "repairs the stream when the bot process is killed mid-turn, and reports the kill",
      () =>
        Effect.gen(function* () {
          const runner = yield* startRunner;
          yield* runner.start(1);
          yield* runner.until(is("started"));
          yield* runner.turn(1, "t1");
          const delta = yield* runner.until(
            (frame) =>
              frame.type === "event" &&
              frame.envelope.event.type === "text.delta",
          );
          const event = delta.type === "event" ? delta.envelope.event : null;
          const { pid } = JSON.parse(
            event?.type === "text.delta" ? event.text : "{}",
          ) as { pid: number };
          yield* runner.until(
            (frame) =>
              frame.type === "event" &&
              frame.envelope.event.type === "turn.end",
          );
          yield* runner.turn(1, "t2");
          yield* runner.until(is("turn.accepted"));
          process.kill(pid, "SIGKILL");
          expect(yield* runner.until(is("exited"))).toMatchObject({
            code: null,
            signal: "SIGKILL",
          });
          const events = runner.frames.flatMap((frame) =>
            frame.type === "event" ? [frame.envelope] : [],
          );
          expect(events.slice(-2).map((envelope) => envelope.event)).toEqual([
            { type: "error", code: "cli-exited" },
            { type: "turn.end", reason: "error" },
          ]);
          expect(checkStream(events)).toEqual([]);
        }).pipe(Effect.scoped),
      30_000,
    );
  },
);
