import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { bunBotProcesses } from "../adapters/bot-processes";
import { createLogger } from "../log";
import { pipeLink } from "../plugins/link";
import { runBotRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export interface BotRunnerMainOptions {
  readonly bun: string;
  readonly home: string;
}

export async function serveBotRunner(
  options: BotRunnerMainOptions,
): Promise<void> {
  const logger = createLogger({
    write: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.on("error", (error) => {
    logger.error("the bot runner couldn't write to the server", {
      error: error.message,
    });
  });
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
      bun: options.bun,
      home: options.home,
      shutdownGrace: "5 seconds",
      writeDeadline: "5 seconds",
      logger,
    });
  }).pipe(Effect.scoped, Effect.provide(bunBotProcesses));
  await Effect.runPromise(program);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      bun: { type: "string", default: process.execPath },
      home: { type: "string", default: "/var/lib/aphelion-bots" },
    },
  });
  await serveBotRunner({ bun: values.bun, home: values.home });
  process.exit(0);
}
