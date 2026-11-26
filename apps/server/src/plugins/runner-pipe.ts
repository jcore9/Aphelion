import { Effect, Layer } from "effect";
import type { z } from "zod";
import { fdReadable, fdWriter } from "../adapters/fd-pipe";
import type { Logger } from "../log";
import { RunnerLink } from "./host";
import { pipeLink, type Framing } from "./link";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export interface RunnerPipeFds {
  readonly replies: number;
  readonly requests: number;
}

export const fdPipeLink = <In, Out>(
  fds: RunnerPipeFds,
  framing: Framing<In>,
  sends: z.ZodType<Out>,
  onWriteError: (error: Error) => void,
) =>
  Effect.gen(function* () {
    const requests = fdWriter(fds.requests, onWriteError);
    yield* Effect.addFinalizer(() => Effect.promise(requests.end));
    return yield* pipeLink(
      fdReadable(fds.replies),
      requests.write,
      framing,
      sends,
    );
  });

export const runnerPipeLink = (fds: RunnerPipeFds, logger: Logger) =>
  Layer.effect(
    RunnerLink,
    fdPipeLink(
      fds,
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
      (error) => {
        logger.error("the server couldn't write to the plugin runner", {
          error: error.message,
        });
      },
    ),
  );
