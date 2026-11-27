import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { Effect, Layer } from "effect";
import { supervisedBotProcesses } from "../adapters/supervised-bot-processes";
import {
  maxSupervisorFrameBytes,
  supervisorReplySchema,
  supervisorRequestSchema,
} from "../cgroups/protocol";
import { createLogger } from "../log";
import { defaultRestartPolicy } from "../plugins/lifecycle";
import { pipeLink } from "../plugins/link";
import { fdPipeLink, type RunnerPipeFds } from "../plugins/runner-pipe";
import { runBotRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export async function serveBotRunner(supervisor: RunnerPipeFds): Promise<void> {
  const logger = createLogger({
    write: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.on("error", (error) => {
    logger.error("the bot runner couldn't write to the server", {
      error: error.message,
    });
  });
  const processes = Layer.unwrap(
    fdPipeLink(
      supervisor,
      {
        schema: supervisorReplySchema,
        maxBytes: maxSupervisorFrameBytes,
        onDrop: (reason) =>
          Effect.sync(() => {
            logger.warn("the bot runner dropped a frame from the supervisor", {
              reason,
            });
          }),
      },
      supervisorRequestSchema,
      (error) => {
        logger.error("the bot runner couldn't write to the cgroup supervisor", {
          error: error.message,
        });
      },
    ).pipe(Effect.map((link) => supervisedBotProcesses(link, logger))),
  );
  const program = Effect.gen(function* () {
    const link = yield* pipeLink(
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
      (text) =>
        new Promise((done) => {
          process.stdout.write(text, () => {
            done(undefined);
          });
        }),
      {
        schema: runnerRequestSchema,
        maxBytes: maxFrameBytes,
        onDrop: (reason) =>
          Effect.sync(() => {
            logger.warn("the bot runner dropped a frame", { reason });
          }),
      },
      runnerReplySchema,
    );
    yield* runBotRunner(link, {
      shutdownGrace: "5 seconds",
      writeDeadline: "5 seconds",
      handshakeDeadline: defaultRestartPolicy.handshakeMs,
      logger,
    });
  }).pipe(Effect.provide(processes), Effect.scoped);
  await Effect.runPromise(program);
}

const fdsOf = (text: string): RunnerPipeFds => {
  const [replies, requests] = text.split(",").map(Number);
  if (!Number.isInteger(replies) || !Number.isInteger(requests)) {
    throw new Error("--supervisor-fds takes two descriptors, such as 3,4");
  }
  return { replies: replies ?? 3, requests: requests ?? 4 };
};

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "supervisor-fds": { type: "string", default: "3,4" } },
  });
  await serveBotRunner(fdsOf(values["supervisor-fds"]));
  process.exit(0);
}
