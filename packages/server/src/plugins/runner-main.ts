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

const { values } = parseArgs({
  options: {
    bun: { type: "string", default: process.execPath },
    data: { type: "string", default: "/var/lib/aphelion-plugins" },
  },
});

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
  yield* runRunner(link, { dataRoot: values.data, sweepEvery: "10 seconds" });
}).pipe(Effect.scoped, Effect.provide(bunPluginProcesses(values.bun)));

await Effect.runPromise(program);
process.exit(0);
