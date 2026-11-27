import { spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Option, Queue } from "effect";
import { describe } from "vitest";
import { BotProcesses } from "../bots/processes";
import {
  maxSupervisorFrameBytes,
  supervisorReplySchema,
  supervisorRequestSchema,
  type SupervisorReply,
  type SupervisorRequest,
} from "../cgroups/protocol";
import { createLogger } from "../log";
import { Secret } from "../secrets";
import { memoryLinkPair, type Framing } from "../plugins/link";
import { supervisedBotProcesses } from "./supervised-bot-processes";

const framing = <T>(schema: Framing<T>["schema"]): Framing<T> => ({
  schema,
  maxBytes: maxSupervisorFrameBytes,
  onDrop: () => Effect.void,
});

const fifos = Effect.acquireRelease(
  Effect.sync(() => {
    const folder = mkdtempSync(join(tmpdir(), "aphelion-run-"));
    const paths = {
      stdin: join(folder, "stdin"),
      stdout: join(folder, "stdout"),
      stderr: join(folder, "stderr"),
    };
    spawnSync("mkfifo", [paths.stdin, paths.stdout, paths.stderr]);
    const reader = openSync(
      paths.stdin,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    return { folder, paths, reader };
  }),
  ({ folder, reader }) =>
    Effect.sync(() => {
      closeSync(reader);
      rmSync(folder, { recursive: true, force: true });
    }),
);

describe("the bot runner's supervised processes", () => {
  it.live(
    "asks the supervisor again when a kill failed, and stops asking once it succeeded",
    () =>
      Effect.gen(function* () {
        const { paths } = yield* fifos;
        const { a, b } = yield* memoryLinkPair<
          SupervisorRequest,
          SupervisorReply
        >(framing(supervisorRequestSchema), framing(supervisorReplySchema));
        const next = Queue.take(a.incoming).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        yield* a.send({ type: "ready" });
        const services = yield* Layer.build(
          supervisedBotProcesses(b, createLogger({ write: () => undefined })),
        );
        const processes = Context.get(services, BotProcesses);
        const starting = yield* processes
          .start({ bot: "alpha", adapter: "fake", folder: "/srv/alpha" })
          .pipe(Effect.forkScoped);
        const start = yield* next;
        expect(start).toMatchObject({
          type: "start",
          bot: "alpha",
          adapter: "fake",
          folder: "/srv/alpha",
        });
        if (start.type !== "start") throw new Error("expected a start");
        const { run } = start;
        yield* a.send({ type: "started", run, ...paths });
        const { kill } = yield* Fiber.join(starting);

        const first = yield* kill.pipe(Effect.flip, Effect.forkScoped);
        expect(yield* next).toEqual({ type: "kill", run });
        yield* a.send({
          type: "kill-failed",
          run,
          reason: "populated: ETIMEDOUT",
        });
        expect(yield* Fiber.join(first)).toMatchObject({
          _tag: "KillFailed",
          reason: "populated: ETIMEDOUT",
        });

        const second = yield* kill.pipe(Effect.forkScoped);
        expect(yield* next).toEqual({ type: "kill", run });
        yield* a.send({ type: "killed", run });
        yield* Fiber.join(second);

        yield* kill;
        expect(Option.isNone(yield* Queue.poll(a.incoming))).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live(
    "puts the spec's API key in the supervisor's start frame, and sends no key field when the spec has none",
    () =>
      Effect.gen(function* () {
        const { a, b } = yield* memoryLinkPair<
          SupervisorRequest,
          SupervisorReply
        >(framing(supervisorRequestSchema), framing(supervisorReplySchema));
        const next = Queue.take(a.incoming).pipe(
          Effect.timeout("2 seconds"),
          Effect.orDie,
        );
        yield* a.send({ type: "ready" });
        const services = yield* Layer.build(
          supervisedBotProcesses(b, createLogger({ write: () => undefined })),
        );
        const processes = Context.get(services, BotProcesses);
        const fakeKey = "sk-ant-fake-supervised-0123456789";
        const apiKey = Secret.make(fakeKey, { label: "API key" });
        yield* processes
          .start({
            bot: "alpha",
            adapter: "claude",
            folder: "/srv/alpha",
            apiKey,
          })
          .pipe(Effect.forkScoped);
        const keyed = yield* next;
        expect(keyed.type === "start" && keyed.apiKey === fakeKey).toBe(true);
        expect(apiKey.wiped).toBe(false);
        yield* processes
          .start({ bot: "beta", adapter: "claude", folder: "/srv/beta" })
          .pipe(Effect.forkScoped);
        const plain = yield* next;
        expect(Object.keys(plain).sort()).toEqual([
          "adapter",
          "bot",
          "folder",
          "run",
          "type",
        ]);
      }).pipe(Effect.scoped),
  );
});
