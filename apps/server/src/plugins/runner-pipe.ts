import { createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { Effect, Layer } from "effect";
import type { Logger } from "../log";
import { RunnerLink } from "./host";
import { pipeLink } from "./link";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export interface RunnerPipeFds {
  readonly replies: number;
  readonly requests: number;
}

export const runnerPipeLink = (fds: RunnerPipeFds, logger: Logger) =>
  Layer.effect(
    RunnerLink,
    Effect.gen(function* () {
      const requests = createWriteStream("", { fd: fds.requests });
      requests.on("error", (error) => {
        logger.error("the server couldn't write to the plugin runner", {
          error: error.message,
        });
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          requests.end();
        }),
      );
      return yield* pipeLink(
        Readable.toWeb(
          createReadStream("", { fd: fds.replies }),
        ) as ReadableStream<Uint8Array>,
        (text) =>
          new Promise((done) => {
            requests.write(text, () => {
              done(undefined);
            });
          }),
        {
          schema: runnerReplySchema,
          maxBytes: maxFrameBytes,
          onDrop: (reason) =>
            Effect.sync(() => {
              logger.warn("the plugin host dropped a frame from the runner", {
                reason,
              });
            }),
        },
        runnerRequestSchema,
      );
    }),
  );
