import { access, constants, mkdir } from "node:fs/promises";
import type { Subprocess } from "bun";
import { Effect, Layer, Stream } from "effect";
import { BotProcesses, type BotProcess, type BotSpec } from "../bots/processes";
import { SpawnFailed } from "../plugins/processes";
import {
  freezeAndKill,
  isGone,
  libc,
  PR_SET_DUMPABLE,
  read,
  type Proc,
} from "./process-tree";

type Piped = Subprocess<"pipe", "pipe", "pipe">;

const bytes = (stream: ReadableStream<Uint8Array>) =>
  Stream.fromReadableStream({
    evaluate: () => stream,
    onError: (error) => error,
  }).pipe(Stream.orDie);

const waitUntilGone = (procs: readonly Proc[]) =>
  Effect.gen(function* () {
    let left = procs.filter((proc) => !isGone(proc));
    for (let tries = 0; left.length > 0 && tries < 200; tries++) {
      yield* Effect.sleep("10 millis");
      left = left.filter((proc) => !isGone(proc));
    }
    return left.length;
  });

export interface BunBotOptions {
  readonly bun: string;
  readonly launcher: string;
}

export const bunBotProcesses = (options: BunBotOptions) =>
  Layer.effect(
    BotProcesses,
    Effect.gen(function* () {
      if (libc().prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) {
        return yield* Effect.die(
          new Error("the bot runner couldn't hide its memory and pipes"),
        );
      }
      const running = new Map<string, Piped>();

      const start = (spec: BotSpec) =>
        Effect.gen(function* () {
          const fail = (reason: string) => new SpawnFailed({ reason });
          if (running.has(spec.bot)) return yield* fail("already running");
          yield* Effect.tryPromise({
            try: () => access(spec.adapter, constants.R_OK),
            catch: () => fail("the adapter bundle isn't there"),
          });
          yield* Effect.tryPromise({
            try: () => mkdir(spec.cwd, { recursive: true, mode: 0o750 }),
            catch: () => fail("the bot's folder can't be created"),
          });
          const argv = [
            options.bun,
            "--no-env-file",
            "--preload",
            options.launcher,
            spec.adapter,
          ];
          const child = yield* Effect.try({
            try: (): Piped =>
              Bun.spawn(argv, {
                cwd: spec.cwd,
                env: { ...spec.env },
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              }),
            catch: () => fail("the bot's adapter couldn't be started"),
          });
          running.set(spec.bot, child);
          const ended = child.exited.then(() => {
            if (running.get(spec.bot) === child) running.delete(spec.bot);
          });
          return {
            write: (line) =>
              Effect.tryPromise(async () => {
                await child.stdin.write(`${line}\n`);
                await child.stdin.flush();
              }).pipe(Effect.ignore),
            stdout: bytes(child.stdout),
            stderr: bytes(child.stderr),
            exited: Effect.promise(() => ended).pipe(
              Effect.map(() => ({
                code: child.exitCode,
                signal:
                  child.signalCode === null ? null : String(child.signalCode),
              })),
            ),
          } satisfies BotProcess;
        });

      const stopAll = (bot: string) =>
        Effect.gen(function* () {
          const child = running.get(bot);
          if (child === undefined) return { survivors: 0 };
          const root = () => {
            const alive = child.exitCode === null && child.signalCode === null;
            const proc = alive ? read(child.pid) : undefined;
            return proc ? [proc] : [];
          };
          const survivors = yield* waitUntilGone(freezeAndKill(root));
          const exited = yield* Effect.promise(() => child.exited).pipe(
            Effect.timeout("5 seconds"),
            Effect.option,
          );
          return { survivors: survivors + (exited._tag === "None" ? 1 : 0) };
        });

      return BotProcesses.of({ start, stopAll });
    }),
  );
