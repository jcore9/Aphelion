import { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { bunPluginProcesses } from "../adapters/plugin-processes";
import { createLogger } from "../log";
import { pipeLink } from "./link";
import { runRunner } from "./runner";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export interface RunnerMainOptions {
  readonly bun: string;
  readonly data: string;
  readonly pluginUid: number;
}

export async function serveRunner(options: RunnerMainOptions): Promise<void> {
  const logger = createLogger({
    write: (line) => process.stderr.write(`${line}\n`),
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
            logger.warn("plugin runner dropped a frame", { reason });
          }),
      },
      runnerReplySchema,
    );
    yield* runRunner(link, {
      dataRoot: options.data,
      sweepEvery: "10 seconds",
      inputDeadline: "5 seconds",
      logger,
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(bunPluginProcesses(options.bun, options.pluginUid)),
  );
  await Effect.runPromise(program);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      bun: { type: "string", default: process.execPath },
      data: { type: "string", default: "/var/lib/aphelion-plugins" },
    },
  });
  const pluginUid = process.getuid?.();
  if (pluginUid === undefined) {
    throw new Error("the plugin runner runs only on Linux");
  }
  await serveRunner({ bun: values.bun, data: values.data, pluginUid });
  process.exit(0);
}
