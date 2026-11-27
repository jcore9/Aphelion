import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Queue } from "effect";
import { describe } from "vitest";
import type { z } from "zod";
import { createLogger } from "../log";
import { maskKnownValues } from "../log/masks";
import { memoryLinkPair, type Framing } from "../plugins/link";
import type { ProcessExit } from "../plugins/processes";
import {
  maxSupervisorFrameBytes,
  supervisorReplySchema,
  supervisorRequestSchema,
  type SupervisorReply,
  type SupervisorRequest,
} from "./protocol";
import {
  CgroupHost,
  HostFailed,
  probeBot,
  probeReserved,
  runSupervisor,
  type RunPaths,
  type SupervisedChild,
} from "./supervisor";

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxSupervisorFrameBytes,
  onDrop: () => Effect.void,
});

const runA = "0197a3c2-5f1e-7a2b-8c3d-4e5f60718293";
const runB = "0197a3c2-5f1e-7a2b-9c3d-4e5f60718294";

const keyVariable = "ANTHROPIC_API_KEY";

const adapters = {
  fake: { bundle: "/adapters/fake.js", env: { HOME: "/home/bots" } },
  keyed: {
    bundle: "/adapters/keyed.js",
    env: { HOME: "/home/bots" },
    apiKeyVariable: keyVariable,
  },
  probe: { bundle: "/adapters/probe.js", env: { HOME: "/tmp" } },
};

const fakeKey = "sk-ant-fake-supervisor-canary-0123456789";

interface FakeChild {
  readonly run: string;
  readonly bot: string;
  readonly bundle: string;
  readonly envNames: readonly string[];
  readonly keyBytes: number | undefined;
  readonly placed: Deferred.Deferred<boolean>;
  readonly exit: Deferred.Deferred<ProcessExit>;
}

interface HostOptions {
  readonly failStep?: string;
  readonly holdPlacement?: boolean;
  readonly spawnFails?: boolean;
  readonly killFails?: { readonly run: string; times: number };
  readonly killGate?: {
    readonly run: string;
    readonly open: Deferred.Deferred<undefined>;
  };
}

const fakeHost = (options: HostOptions = {}) =>
  Effect.sync(() => {
    const calls: string[] = [];
    const children: FakeChild[] = [];
    const runOf = (paths: RunPaths) => paths.leaf.slice("/leaf/".length);
    const step = (name: string) =>
      options.failStep === name
        ? Effect.fail(new HostFailed({ step: name, errno: "EACCES" }))
        : Effect.void;
    const host = CgroupHost.of({
      makeRun: (run) =>
        Effect.gen(function* () {
          calls.push(`make ${run}`);
          yield* step("start");
          return {
            leaf: `/leaf/${run}`,
            folder: `/runs/${run}`,
            stdin: `/runs/${run}/stdin`,
            stdout: `/runs/${run}/stdout`,
            stderr: `/runs/${run}/stderr`,
          };
        }),
      spawn: (paths, entry, bot, folder, kind) =>
        Effect.gen(function* () {
          const run = runOf(paths);
          calls.push(`spawn ${run} ${entry.bundle} ${bot} ${folder} ${kind}`);
          if (options.spawnFails === true && kind === "bot") {
            return yield* new HostFailed({ step: "spawn", errno: "ENOENT" });
          }
          const key = entry.env[keyVariable];
          const child: FakeChild = {
            run,
            bot,
            bundle: entry.bundle,
            envNames: Object.keys(entry.env).sort(),
            keyBytes: key === undefined ? undefined : Buffer.byteLength(key),
            placed: yield* Deferred.make<boolean>(),
            exit: yield* Deferred.make<ProcessExit>(),
          };
          children.push(child);
          if (options.holdPlacement !== true) {
            yield* Deferred.succeed(child.placed, true);
          }
          return {
            pid: 1000 + children.length,
            placed: Deferred.await(child.placed),
            exited: Deferred.await(child.exit),
            abort: Effect.void,
          } satisfies SupervisedChild;
        }),
      kill: (paths) =>
        Effect.gen(function* () {
          const run = runOf(paths);
          calls.push(`kill ${run}`);
          const fails = options.killFails;
          if (fails?.run === run && fails.times > 0) {
            fails.times -= 1;
            return yield* new HostFailed({
              step: "populated",
              errno: "ETIMEDOUT",
            });
          }
          if (options.killGate?.run === run) {
            yield* Deferred.await(options.killGate.open);
          }
          for (const child of children) {
            if (child.run === run) {
              yield* Deferred.succeed(child.exit, {
                code: null,
                signal: "SIGKILL",
              });
            }
          }
          calls.push(`killed ${run}`);
        }),
      removeRun: (paths) =>
        Effect.sync(() => {
          calls.push(`remove ${runOf(paths)}`);
        }),
      probe: {
        ownCgroup: step("own-cgroup"),
        placed: () => step("placed"),
        dropped: () => step("drop"),
        botDenied: () => step("bot-denied"),
        gone: () => step("gone"),
      },
    });
    return { host, calls, children };
  });

const supervisor = (options: HostOptions = {}) =>
  Effect.gen(function* () {
    const fake = yield* fakeHost(options);
    const { a, b } = yield* memoryLinkPair<SupervisorReply, SupervisorRequest>(
      framing(supervisorReplySchema),
      framing(supervisorRequestSchema),
    );
    const logs: string[] = [];
    yield* runSupervisor(b, {
      adapters,
      logger: createLogger({ write: (line) => logs.push(line) }),
    }).pipe(Effect.provideService(CgroupHost, fake.host), Effect.forkScoped);
    const frames: SupervisorReply[] = [];
    const unread: SupervisorReply[] = [];
    const until = (done: (frame: SupervisorReply) => boolean) =>
      Effect.gen(function* () {
        const waiting = unread.findIndex(done);
        if (waiting >= 0)
          return unread.splice(waiting, 1)[0] as SupervisorReply;
        for (;;) {
          const frame = yield* Queue.take(a.incoming);
          frames.push(frame);
          if (done(frame)) return frame;
          unread.push(frame);
        }
      }).pipe(Effect.timeout("2 seconds"), Effect.orDie);
    const send = (frame: z.input<typeof supervisorRequestSchema>) =>
      a.send(supervisorRequestSchema.parse(frame));
    const childAt = (index: number) =>
      Effect.gen(function* () {
        for (;;) {
          const child = fake.children[index];
          if (child) return child;
          yield* Effect.sleep("5 millis");
        }
      }).pipe(Effect.timeout("2 seconds"), Effect.orDie);
    return { ...fake, frames, logs, until, send, childAt };
  });

const is =
  (type: SupervisorReply["type"], run?: string) => (frame: SupervisorReply) =>
    frame.type === type &&
    (run === undefined || ("run" in frame && frame.run === run));

const start = (
  run: string,
  adapter = "fake",
  bot = "alpha",
  folder = `/var/lib/aphelion-bots/${bot}`,
) => ({ type: "start", run, bot, adapter, folder }) as const;

describe("the cgroup supervisor", () => {
  it.live(
    "runs its probe through the real start and kill path before it answers anything",
    () =>
      Effect.gen(function* () {
        const { calls, children, until } = yield* supervisor();
        yield* until(is("ready"));
        const probe = children[0];
        expect(probe?.bundle).toBe("/adapters/probe.js");
        expect(calls).toEqual([
          `make ${probe?.run ?? ""}`,
          `spawn ${probe?.run ?? ""} /adapters/probe.js aphelion-probe /tmp/aphelion-probe-${probe?.run ?? ""} probe`,
          `kill ${probe?.run ?? ""}`,
          `killed ${probe?.run ?? ""}`,
          `remove ${probe?.run ?? ""}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "starts a run in its own leaf, replies with its pipes, reports the exit and removes the leaf on kill",
    () =>
      Effect.gen(function* () {
        const { calls, until, send } = yield* supervisor();
        yield* until(is("ready"));
        calls.length = 0;
        yield* send(start(runA));
        expect(yield* until(is("started", runA))).toEqual({
          type: "started",
          run: runA,
          stdin: `/runs/${runA}/stdin`,
          stdout: `/runs/${runA}/stdout`,
          stderr: `/runs/${runA}/stderr`,
        });
        yield* send({ type: "kill", run: runA });
        expect(yield* until(is("exited", runA))).toEqual({
          type: "exited",
          run: runA,
          code: null,
          signal: "SIGKILL",
        });
        yield* until(is("killed", runA));
        expect(calls).toEqual([
          `make ${runA}`,
          `spawn ${runA} /adapters/fake.js alpha /var/lib/aphelion-bots/alpha bot`,
          `kill ${runA}`,
          `killed ${runA}`,
          `remove ${runA}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a run id that isn't a UUIDv7, an unknown adapter, a bad bot id and a second start for a known run",
    () =>
      Effect.gen(function* () {
        const { calls, until, send } = yield* supervisor();
        yield* until(is("ready"));
        calls.length = 0;
        const refused = (run: string) =>
          until(is("start-failed", run)).pipe(
            Effect.map((frame) => ("reason" in frame ? frame.reason : "")),
          );
        const v4 = "0197a3c2-5f1e-4a2b-8c3d-4e5f60718293";
        for (const run of [v4, runA.toUpperCase(), `${runA}/..`, "../x"]) {
          yield* send(start(run));
          expect(yield* refused(run)).toBe("the run id isn't a UUIDv7");
        }
        yield* send(start(runA, "../../bin/sh"));
        expect(yield* refused(runA)).toBe("no adapter has that name");
        yield* send(start(runA, "fake", "../alpha"));
        expect(yield* refused(runA)).toBe("the bot id isn't valid");
        yield* send(start(runA));
        yield* until(is("started", runA));
        yield* send(start(runA));
        expect(yield* refused(runA)).toBe("that run was already started");
        expect(calls.filter((call) => call.startsWith("make"))).toEqual([
          `make ${runA}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a bot folder that isn't an absolute, normalized path, and passes a custom one through",
    () =>
      Effect.gen(function* () {
        const { calls, until, send } = yield* supervisor();
        yield* until(is("ready"));
        calls.length = 0;
        const bad = [
          "bots/alpha",
          "",
          "/var/lib/aphelion-bots/../aphelion",
          "/var/lib/./aphelion-bots/alpha",
          "//var/lib/aphelion-bots/alpha",
          "/var/lib//aphelion-bots/alpha",
          "/var/lib/aphelion-bots/alpha/",
          "/",
          "/var/lib/aphelion-bots/al\0pha",
          "/var/lib/aphelion-bots/al\npha",
          `/${"a".repeat(4096)}`,
        ];
        for (const folder of bad) {
          yield* send(start(runA, "fake", "alpha", folder));
          expect(yield* until(is("start-failed", runA))).toMatchObject({
            reason: "the bot folder isn't an absolute, normalized path",
          });
        }
        expect(calls).toEqual([]);
        yield* send(start(runA, "fake", "alpha", "/srv/volume/alpha"));
        yield* until(is("started", runA));
        expect(calls).toEqual([
          `make ${runA}`,
          `spawn ${runA} /adapters/fake.js alpha /srv/volume/alpha bot`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a start that names the probe's adapter or bot id, which only its own start probe may use",
    () =>
      Effect.gen(function* () {
        const { calls, until, send } = yield* supervisor();
        yield* until(is("ready"));
        calls.length = 0;
        yield* send(start(runA, "probe"));
        expect(yield* until(is("start-failed", runA))).toMatchObject({
          reason: probeReserved,
        });
        yield* send(start(runA, "fake", probeBot));
        expect(yield* until(is("start-failed", runA))).toMatchObject({
          reason: probeReserved,
        });
        yield* send(start(runA, "probe", "alpha", "/tmp/aphelion-probe"));
        expect(yield* until(is("start-failed", runA))).toMatchObject({
          reason: probeReserved,
        });
        expect(calls).toEqual([]);
        yield* send(start(runA));
        yield* until(is("started", runA));
      }).pipe(Effect.scoped),
  );

  it.live("keeps a run whose kill failed, so a later kill can try again", () =>
    Effect.gen(function* () {
      const { calls, until, send } = yield* supervisor({
        killFails: { run: runA, times: 1 },
      });
      yield* until(is("ready"));
      calls.length = 0;
      yield* send(start(runA));
      yield* until(is("started", runA));
      yield* send({ type: "kill", run: runA });
      expect(yield* until(is("kill-failed", runA))).toEqual({
        type: "kill-failed",
        run: runA,
        reason: "populated: ETIMEDOUT",
      });
      yield* send({ type: "kill", run: runA });
      yield* until(is("killed", runA));
      expect(calls.filter((call) => call.startsWith("kill "))).toEqual([
        `kill ${runA}`,
        `kill ${runA}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.live("refuses to kill a run it has no record of", () =>
    Effect.gen(function* () {
      const { calls, until, send } = yield* supervisor();
      yield* until(is("ready"));
      calls.length = 0;
      yield* send({ type: "kill", run: runB });
      expect(yield* until(is("kill-failed", runB))).toEqual({
        type: "kill-failed",
        run: runB,
        reason: "no run has that id",
      });
      yield* send({ type: "kill", run: "../../../sys/fs/cgroup" });
      yield* until(is("kill-failed", "../../../sys/fs/cgroup"));
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    "replies started and lets a kill write cgroup.kill only after the child confirms its placement",
    () =>
      Effect.gen(function* () {
        const { calls, childAt, until, send } = yield* supervisor({
          holdPlacement: true,
        });
        yield* Deferred.succeed((yield* childAt(0)).placed, true);
        yield* until(is("ready"));
        calls.length = 0;
        yield* send(start(runA));
        yield* send({ type: "kill", run: runA });
        yield* Effect.sleep("100 millis");
        expect(calls).toEqual([
          `make ${runA}`,
          `spawn ${runA} /adapters/fake.js alpha /var/lib/aphelion-bots/alpha bot`,
        ]);
        yield* Deferred.succeed((yield* childAt(1)).placed, true);
        yield* until(is("killed", runA));
        expect(calls.slice(2)).toEqual([
          `kill ${runA}`,
          `killed ${runA}`,
          `remove ${runA}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "treats a child that exits before confirming placement as a failed start, and its kill as done",
    () =>
      Effect.gen(function* () {
        const { calls, childAt, until, send } = yield* supervisor({
          holdPlacement: true,
        });
        yield* Deferred.succeed((yield* childAt(0)).placed, true);
        yield* until(is("ready"));
        calls.length = 0;
        yield* send(start(runA));
        yield* send({ type: "kill", run: runA });
        yield* Effect.sleep("50 millis");
        const child = yield* childAt(1);
        yield* Deferred.succeed(child.exit, { code: 1, signal: null });
        yield* Deferred.succeed(child.placed, false);
        expect(yield* until(is("start-failed", runA))).toMatchObject({
          reason: "the adapter couldn't join its cgroup",
        });
        yield* until(is("killed", runA));
        expect(calls).toEqual([
          `make ${runA}`,
          `spawn ${runA} /adapters/fake.js alpha /var/lib/aphelion-bots/alpha bot`,
          `remove ${runA}`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "serializes kills of one run, and never holds up another run's kill",
    () =>
      Effect.gen(function* () {
        const open = yield* Deferred.make<undefined>();
        const { calls, until, send } = yield* supervisor({
          killGate: { run: runA, open },
        });
        yield* until(is("ready"));
        calls.length = 0;
        yield* send(start(runA));
        yield* send(start(runB));
        yield* until(is("started", runA));
        yield* until(is("started", runB));
        yield* send({ type: "kill", run: runA });
        yield* send({ type: "kill", run: runA });
        yield* send({ type: "kill", run: runB });
        yield* until(is("killed", runB));
        yield* Deferred.succeed(open, undefined);
        yield* until(is("killed", runA));
        yield* until(is("killed", runA));
        expect(calls.filter((call) => call === `kill ${runA}`)).toEqual([
          `kill ${runA}`,
        ]);
        expect(calls.filter((call) => call === `remove ${runA}`)).toEqual([
          `remove ${runA}`,
        ]);
      }).pipe(Effect.scoped),
  );

  for (const step of [
    "own-cgroup",
    "start",
    "placed",
    "drop",
    "bot-denied",
    "gone",
  ]) {
    it.live(
      `fails closed when the probe fails at ${step}: it reports the step and refuses every start`,
      () =>
        Effect.gen(function* () {
          const { calls, until, send } = yield* supervisor({ failStep: step });
          expect(yield* until(is("unsafe"))).toEqual({
            type: "unsafe",
            step,
            errno: "EACCES",
          });
          calls.length = 0;
          yield* send(start(runA));
          expect(yield* until(is("start-failed", runA))).toMatchObject({
            reason: "the cgroup check failed, so no bot starts",
          });
          expect(calls).toEqual([]);
        }).pipe(Effect.scoped),
    );
  }

  it.live(
    "puts a start's API key in the adapter's environment under the table's variable, and keeps it out of the table, the replies and the log",
    () =>
      Effect.gen(function* () {
        const { until, send, childAt, frames, logs } = yield* supervisor();
        yield* until(is("ready"));
        yield* send({ ...start(runA, "keyed"), apiKey: fakeKey });
        yield* until(is("started", runA));
        const child = yield* childAt(1);
        expect(child.envNames).toEqual(["ANTHROPIC_API_KEY", "HOME"]);
        expect(child.keyBytes).toBe(fakeKey.length);
        expect(Object.keys(adapters.keyed.env)).toEqual(["HOME"]);
        yield* send({ type: "kill", run: runA });
        yield* until(is("killed", runA));
        expect(JSON.stringify(frames)).not.toContain(fakeKey);
        expect(logs.join("\n")).not.toContain(fakeKey);
      }).pipe(Effect.scoped),
  );

  it.live(
    "wipes the key as soon as the spawn returns, before the adapter joins its cgroup",
    () =>
      Effect.gen(function* () {
        const heldKey = "sk-ant-fake-supervisor-held-0123456789";
        const held = () => maskKnownValues(heldKey, "#") !== heldKey;
        const { until, send, childAt } = yield* supervisor({
          holdPlacement: true,
        });
        yield* Deferred.succeed((yield* childAt(0)).placed, true);
        yield* until(is("ready"));
        yield* send({ ...start(runA, "keyed"), apiKey: heldKey });
        const child = yield* childAt(1);
        expect(child.keyBytes).toBe(heldKey.length);
        yield* Effect.sleep("20 millis");
        const heldWhileJoining = held();
        yield* Deferred.succeed(child.placed, true);
        yield* until(is("started", runA));
        expect(heldWhileJoining).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live(
    "starts a keyed adapter without the variable when the start carries no key, and the probe never gets one",
    () =>
      Effect.gen(function* () {
        const { until, send, childAt } = yield* supervisor();
        yield* until(is("ready"));
        yield* send(start(runA, "keyed"));
        yield* until(is("started", runA));
        expect((yield* childAt(0)).envNames).toEqual(["HOME"]);
        expect((yield* childAt(1)).envNames).toEqual(["HOME"]);
      }).pipe(Effect.scoped),
  );

  it.live(
    "refuses a key for an adapter whose table entry names no variable, and never spawns it",
    () =>
      Effect.gen(function* () {
        const { calls, until, send, logs } = yield* supervisor();
        yield* until(is("ready"));
        calls.length = 0;
        yield* send({ ...start(runA), apiKey: fakeKey });
        expect(yield* until(is("start-failed", runA))).toEqual({
          type: "start-failed",
          run: runA,
          reason: "that adapter takes no API key",
        });
        yield* send({ ...start(runB, "probe", probeBot), apiKey: fakeKey });
        expect(yield* until(is("start-failed", runB))).toMatchObject({
          reason: probeReserved,
        });
        expect(calls).toEqual([]);
        expect(logs.join("\n")).not.toContain(fakeKey);
      }).pipe(Effect.scoped),
  );

  it.live(
    "keeps the key out of the failure it logs and sends when the spawn fails",
    () =>
      Effect.gen(function* () {
        const { until, send, frames, logs } = yield* supervisor({
          spawnFails: true,
        });
        yield* until(is("ready"));
        yield* send({ ...start(runA, "keyed"), apiKey: fakeKey });
        expect(yield* until(is("start-failed", runA))).toMatchObject({
          reason: "spawn: ENOENT",
        });
        expect(logs.join("\n")).toContain(
          "the supervisor couldn't start an adapter",
        );
        expect(JSON.stringify(frames)).not.toContain(fakeKey);
        expect(logs.join("\n")).not.toContain(fakeKey);
      }).pipe(Effect.scoped),
  );
});
