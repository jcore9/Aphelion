import { randomUUIDv7 } from "node:crypto";
import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Queue,
} from "effect";
import type { Logger } from "../log";
import type { Link } from "../plugins/link";
import type { ProcessExit } from "../plugins/processes";
import {
  botIdPattern,
  isBotFolder,
  runIdPattern,
  type SupervisorReply,
  type SupervisorRequest,
} from "./protocol";

export interface AdapterEntry {
  readonly bundle: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface RunPaths {
  readonly leaf: string;
  readonly folder: string;
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SupervisedChild {
  readonly pid: number;
  readonly placed: Effect.Effect<boolean>;
  readonly exited: Effect.Effect<ProcessExit>;
  readonly abort: Effect.Effect<void>;
}

export class HostFailed extends Data.TaggedError("HostFailed")<{
  readonly step: string;
  readonly errno: string;
}> {}

class Refused extends Data.TaggedError("Refused")<{
  readonly reason: string;
}> {}

export class CgroupHost extends Context.Service<
  CgroupHost,
  {
    readonly makeRun: (run: string) => Effect.Effect<RunPaths, HostFailed>;
    readonly spawn: (
      paths: RunPaths,
      entry: AdapterEntry,
      bot: string,
      folder: string,
    ) => Effect.Effect<SupervisedChild, HostFailed>;
    readonly kill: (paths: RunPaths) => Effect.Effect<void, HostFailed>;
    readonly removeRun: (paths: RunPaths) => Effect.Effect<void, HostFailed>;
    readonly probe: {
      readonly ownCgroup: Effect.Effect<void, HostFailed>;
      readonly placed: (
        paths: RunPaths,
        pid: number,
      ) => Effect.Effect<void, HostFailed>;
      readonly dropped: (
        paths: RunPaths,
        pid: number,
      ) => Effect.Effect<void, HostFailed>;
      readonly botDenied: (paths: RunPaths) => Effect.Effect<void, HostFailed>;
      readonly gone: (
        paths: RunPaths,
        pid: number,
      ) => Effect.Effect<void, HostFailed>;
    };
  }
>()("aphelion/cgroups/CgroupHost") {}

export const probeBot = "aphelion-probe";
export const probeAdapter = "probe";
export const probeFolder = "/tmp/aphelion-probe";
export const unsafeReason = "the cgroup check failed, so no bot starts";

export interface SupervisorOptions {
  readonly adapters: Readonly<Record<string, AdapterEntry>>;
  readonly logger: Logger;
}

interface RunRecord {
  readonly settled: Deferred.Deferred<undefined>;
  paths: RunPaths | undefined;
  child: SupervisedChild | undefined;
  done: boolean;
  killing: Deferred.Deferred<undefined, Refused | HostFailed> | undefined;
}

interface Started {
  readonly paths: RunPaths;
  readonly child: SupervisedChild;
}

const reasonOf = (error: Refused | HostFailed) =>
  error._tag === "Refused" ? error.reason : `${error.step}: ${error.errno}`;

export const runSupervisor = (
  link: Link<SupervisorRequest, SupervisorReply>,
  options: SupervisorOptions,
) =>
  Effect.gen(function* () {
    const host = yield* CgroupHost;
    const { logger } = options;
    const records = new Map<string, RunRecord>();
    const known = new Set<string>();
    const work = yield* FiberSet.make();

    const register = (
      run: string,
      bot: string,
      adapter: string,
      folder: string,
    ) =>
      Effect.gen(function* () {
        if (!runIdPattern.test(run)) {
          return yield* new Refused({ reason: "the run id isn't a UUIDv7" });
        }
        const entry = Object.hasOwn(options.adapters, adapter)
          ? options.adapters[adapter]
          : undefined;
        if (entry === undefined) {
          return yield* new Refused({ reason: "no adapter has that name" });
        }
        if (!botIdPattern.test(bot)) {
          return yield* new Refused({ reason: "the bot id isn't valid" });
        }
        if (!isBotFolder(folder)) {
          return yield* new Refused({
            reason: "the bot folder isn't an absolute, normalized path",
          });
        }
        if (known.has(run)) {
          return yield* new Refused({ reason: "that run was already started" });
        }
        known.add(run);
        const record: RunRecord = {
          settled: yield* Deferred.make<undefined>(),
          paths: undefined,
          child: undefined,
          done: false,
          killing: undefined,
        };
        records.set(run, record);
        return { record, entry };
      });

    const launch = (
      run: string,
      bot: string,
      folder: string,
      record: RunRecord,
      entry: AdapterEntry,
    ) =>
      Effect.gen(function* () {
        const paths = yield* host.makeRun(run);
        record.paths = paths;
        const child = yield* host
          .spawn(paths, entry, bot, folder)
          .pipe(Effect.tapError(() => Effect.ignore(host.removeRun(paths))));
        record.child = child;
        if (yield* child.placed) return { paths, child } satisfies Started;
        yield* child.abort;
        yield* child.exited.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        yield* Effect.ignore(host.removeRun(paths));
        return yield* new Refused({
          reason: "the adapter couldn't join its cgroup",
        });
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            record.done = true;
            records.delete(run);
          }),
        ),
        Effect.ensuring(Deferred.succeed(record.settled, undefined)),
      );

    const finishKill = (run: string, record: RunRecord) =>
      Effect.gen(function* () {
        yield* Deferred.await(record.settled);
        if (record.done || record.paths === undefined) return;
        yield* host.kill(record.paths);
        yield* host.removeRun(record.paths);
        if (record.child) {
          yield* record.child.exited.pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore,
          );
        }
        record.done = true;
        records.delete(run);
      });

    const kill = (run: string) =>
      Effect.gen(function* () {
        const record = records.get(run);
        if (record === undefined) {
          return yield* new Refused({ reason: "no run has that id" });
        }
        if (record.killing) return yield* Deferred.await(record.killing);
        const killing = yield* Deferred.make<undefined, Refused | HostFailed>();
        record.killing = killing;
        return yield* Effect.gen(function* () {
          const outcome = yield* Effect.exit(finishKill(run, record));
          if (Exit.isFailure(outcome)) record.killing = undefined;
          yield* Deferred.done(
            killing,
            Exit.map(outcome, () => undefined),
          );
          return yield* outcome;
        });
      });

    const at = <A, R>(
      step: string,
      effect: Effect.Effect<A, Refused | HostFailed, R>,
    ) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new HostFailed({
              step,
              errno: error._tag === "Refused" ? error.reason : error.errno,
            }),
        ),
      );

    const probe = Effect.gen(function* () {
      yield* at("own-cgroup", host.probe.ownCgroup);
      const run = randomUUIDv7();
      const { paths, child } = yield* at(
        "start",
        Effect.gen(function* () {
          const { record, entry } = yield* register(
            run,
            probeBot,
            probeAdapter,
            probeFolder,
          );
          return yield* launch(run, probeBot, probeFolder, record, entry);
        }),
      );
      const killed = at("kill", kill(run));
      yield* Effect.gen(function* () {
        yield* at("placed", host.probe.placed(paths, child.pid));
        yield* at("drop", host.probe.dropped(paths, child.pid));
        yield* at("bot-denied", host.probe.botDenied(paths));
      }).pipe(Effect.tapError(() => Effect.ignore(killed)));
      yield* killed;
      yield* at("gone", host.probe.gone(paths, child.pid));
    });

    const verdict = yield* Effect.result(probe);
    const unsafe = verdict._tag === "Failure" ? verdict.failure : undefined;
    if (unsafe === undefined) {
      logger.info("the cgroup check passed, so bots can start");
      yield* link.send({ type: "ready" });
    } else {
      logger.error("the cgroup check failed, so no bot starts", {
        step: unsafe.step,
        errno: unsafe.errno,
      });
      yield* link.send({
        type: "unsafe",
        step: unsafe.step,
        errno: unsafe.errno,
      });
    }

    const startRequest = (
      request: Extract<SupervisorRequest, { type: "start" }>,
    ) =>
      Effect.gen(function* () {
        const failed = (reason: string) =>
          link.send({ type: "start-failed", run: request.run, reason });
        if (unsafe !== undefined) return yield* failed(unsafeReason);
        const registered = yield* Effect.result(
          register(request.run, request.bot, request.adapter, request.folder),
        );
        if (registered._tag === "Failure") {
          return yield* failed(registered.failure.reason);
        }
        const { record, entry } = registered.success;
        yield* FiberSet.run(
          work,
          launch(request.run, request.bot, request.folder, record, entry).pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                logger.warn("the supervisor couldn't start an adapter", {
                  bot: request.bot,
                  reason: reasonOf(error),
                });
                return failed(reasonOf(error));
              },
              onSuccess: ({ paths, child }) =>
                Effect.gen(function* () {
                  yield* link.send({
                    type: "started",
                    run: request.run,
                    stdin: paths.stdin,
                    stdout: paths.stdout,
                    stderr: paths.stderr,
                  });
                  const exit = yield* child.exited;
                  yield* link.send({
                    type: "exited",
                    run: request.run,
                    ...exit,
                  });
                }),
            }),
          ),
        );
      });

    const killRequest = (run: string) =>
      FiberSet.run(
        work,
        kill(run).pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              if (error._tag === "HostFailed") {
                logger.error(
                  "the supervisor couldn't remove a run's processes",
                  {
                    step: error.step,
                    errno: error.errno,
                  },
                );
              }
              return link.send({
                type: "kill-failed",
                run,
                reason: reasonOf(error),
              });
            },
            onSuccess: () => link.send({ type: "killed", run }),
          }),
        ),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...records.keys()], (run) => Effect.ignore(kill(run)), {
        concurrency: "unbounded",
        discard: true,
      }),
    );

    yield* Queue.take(link.incoming).pipe(
      Effect.flatMap((request) =>
        request.type === "start"
          ? startRequest(request)
          : killRequest(request.run),
      ),
      Effect.forever,
    );
  }).pipe(Effect.catchIf(Cause.isDone, () => Effect.void));
