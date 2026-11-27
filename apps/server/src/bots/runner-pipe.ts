import { Effect, Exit, Layer, Scope } from "effect";
import { fdReader, fdWriter } from "../adapters/fd-pipe";
import type { Logger } from "../log";
import { pipeLink } from "../plugins/link";
import type { RunnerPipeFds } from "../plugins/runner-pipe";
import { BotRunnerLink } from "./manager";
import {
  maxFrameBytes,
  runnerReplySchema,
  runnerRequestSchema,
} from "./runner-protocol";

export const botRunnerPipeLink = (fds: RunnerPipeFds, logger: Logger) =>
  Layer.effect(
    BotRunnerLink,
    Effect.gen(function* () {
      const linkScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(linkScope, Exit.void));
      const replies = fdReader(fds.replies);
      const requests = fdWriter(fds.requests, (error) => {
        logger.error("the server couldn't write to the bot runner", {
          error: error.message,
        });
      });
      yield* Scope.addFinalizer(linkScope, Effect.promise(requests.end));
      yield* Scope.addFinalizer(linkScope, Effect.promise(replies.close));
      const link = yield* pipeLink(
        replies.stream,
        requests.write,
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
      ).pipe(Scope.provide(linkScope));
      return {
        incoming: link.incoming,
        send: link.send,
        close: Effect.sync(requests.close).pipe(
          Effect.andThen(Effect.promise(replies.close)),
        ),
      };
    }),
  );
