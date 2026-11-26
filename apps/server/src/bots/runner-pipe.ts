import { Effect, Layer } from "effect";
import type { Logger } from "../log";
import { fdPipeLink, type RunnerPipeFds } from "../plugins/runner-pipe";
import { BotRunnerLink } from "./manager";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export const botRunnerPipeLink = (fds: RunnerPipeFds, logger: Logger) =>
  Layer.effect(
    BotRunnerLink,
    fdPipeLink(
      fds,
      {
        schema: runnerReplySchema,
        maxBytes: maxFrameBytes,
        onDrop: (reason) =>
          Effect.sync(() => {
            logger.warn("the server dropped a frame from the bot runner", {
              reason,
            });
          }),
      },
      runnerRequestSchema,
      (error) => {
        logger.error("the server couldn't write to the bot runner", {
          error: error.message,
        });
      },
    ),
  );
