import { randomUUIDv7 } from "node:crypto";
import {
  Cause,
  Deferred,
  Effect,
  Layer,
  Queue,
  Semaphore,
  Stream,
} from "effect";
import {
  BotProcesses,
  CgroupsUnsafe,
  KillFailed,
  type BotProcess,
  type BotSpec,
} from "../bots/processes";
import type { SupervisorReply, SupervisorRequest } from "../cgroups/protocol";
import type { Logger } from "../log";
import type { Link } from "../plugins/link";
import { SpawnFailed, type ProcessExit } from "../plugins/processes";
import { libc, PR_SET_DUMPABLE } from "./process-tree";
import { connectRun } from "./run-fifos";

interface Pipes {
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
}

interface Waiting {
  readonly started: Deferred.Deferred<Pipes, SpawnFailed>;
  readonly exited: Deferred.Deferred<ProcessExit>;
  killed: Deferred.Deferred<undefined, KillFailed>;
}

const bytes = (stream: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (error) => error,
  }).pipe(Stream.orDie);

const supervisorGone = "the cgroup supervisor stopped";

export const supervisedBotProcesses = (
  link: Link<SupervisorReply, SupervisorRequest>,
  logger: Logger,
) =>
  Layer.effect(
    BotProcesses,
    Effect.gen(function* () {
      if (libc().prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) {
        return yield* Effect.die(
          new Error("the bot runner couldn't hide its memory and pipes"),
        );
      }
      const readiness = yield* Deferred.make<CgroupsUnsafe | undefined>();
      const runs = new Map<string, Waiting>();
      let lost = false;

      const dispatch = (reply: SupervisorReply) =>
        Effect.gen(function* () {
          switch (reply.type) {
            case "ready":
              yield* Deferred.succeed(readiness, undefined);
              return;
            case "unsafe":
              logger.error(
                "the cgroup check failed, so the bot runner refuses to start bots",
                { step: reply.step, errno: reply.errno },
              );
              yield* Deferred.succeed(
                readiness,
                new CgroupsUnsafe({ step: reply.step, errno: reply.errno }),
              );
              return;
          }
          const waiting = runs.get(reply.run);
          if (waiting === undefined) return;
          switch (reply.type) {
            case "started":
              yield* Deferred.succeed(waiting.started, reply);
              return;
            case "start-failed":
              yield* Deferred.fail(
                waiting.started,
                new SpawnFailed({ reason: reply.reason }),
              );
              return;
            case "exited":
              yield* Deferred.succeed(waiting.exited, {
                code: reply.code,
                signal: reply.signal,
              });
              return;
            case "killed":
              yield* Deferred.succeed(waiting.killed, undefined);
              return;
            case "kill-failed":
              yield* Deferred.fail(
                waiting.killed,
                new KillFailed({ reason: reply.reason }),
              );
              return;
          }
        });

      yield* Queue.take(link.incoming).pipe(
        Effect.flatMap(dispatch),
        Effect.forever,
        Effect.catchIf(Cause.isDone, () =>
          Effect.gen(function* () {
            lost = true;
            logger.error(
              "the bot runner lost its pipe to the cgroup supervisor",
            );
            yield* Deferred.succeed(
              readiness,
              new CgroupsUnsafe({ step: "supervisor", errno: "EPIPE" }),
            );
            for (const waiting of runs.values()) {
              yield* Deferred.fail(
                waiting.started,
                new SpawnFailed({ reason: supervisorGone }),
              );
              yield* Deferred.succeed(waiting.exited, {
                code: null,
                signal: null,
              });
              yield* Deferred.fail(
                waiting.killed,
                new KillFailed({ reason: supervisorGone }),
              );
            }
          }),
        ),
        Effect.forkScoped,
      );

      const start = (spec: BotSpec) =>
        Effect.gen(function* () {
          const unsafe = yield* Deferred.await(readiness);
          if (unsafe !== undefined) return yield* Effect.fail(unsafe);
          const run = randomUUIDv7();
          const waiting: Waiting = {
            started: yield* Deferred.make<Pipes, SpawnFailed>(),
            exited: yield* Deferred.make<ProcessExit>(),
            killed: yield* Deferred.make<undefined, KillFailed>(),
          };
          runs.set(run, waiting);
          let close: () => void = () => undefined;
          let removed = false;
          const killing = yield* Semaphore.make(1);
          const kill = killing.withPermit(
            Effect.gen(function* () {
              if (removed) return;
              if (lost) {
                return yield* new KillFailed({ reason: supervisorGone });
              }
              waiting.killed = yield* Deferred.make<undefined, KillFailed>();
              yield* link.send({ type: "kill", run });
              yield* Deferred.await(waiting.killed);
              removed = true;
              close();
              runs.delete(run);
            }),
          );
          yield* link.send({
            type: "start",
            run,
            bot: spec.bot,
            adapter: spec.adapter,
          });
          const paths = yield* Deferred.await(waiting.started).pipe(
            Effect.timeoutOrElse({
              duration: "20 seconds",
              orElse: () =>
                Effect.fail(
                  new SpawnFailed({
                    reason: "the cgroup supervisor didn't start the adapter",
                  }),
                ),
            }),
            Effect.tapError(() => Effect.ignore(kill)),
          );
          const pipes = yield* Effect.tryPromise({
            try: () =>
              connectRun(paths, 5_000, (error) => {
                logger.warn("the bot runner couldn't write to an adapter", {
                  bot: spec.bot,
                  error: error.message,
                });
              }),
            catch: () =>
              new SpawnFailed({
                reason: "the adapter's pipes couldn't be opened",
              }),
          }).pipe(Effect.tapError(() => Effect.ignore(kill)));
          close = pipes.close;
          return {
            write: (line) => Effect.promise(() => pipes.write(`${line}\n`)),
            stdout: bytes(pipes.stdout),
            stderr: bytes(pipes.stderr),
            exited: Deferred.await(waiting.exited),
            kill,
          } satisfies BotProcess;
        });

      return BotProcesses.of({ start });
    }),
  );
