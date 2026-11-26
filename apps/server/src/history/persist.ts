import { Effect, Fiber, PubSub, type Scope } from "effect";
import type { BotEvent } from "../bots/manager";
import type { EventStore } from "./event-store";

export const persistBotEvents = (
  subscribe: Effect.Effect<PubSub.Subscription<BotEvent>, never, Scope.Scope>,
  store: Pick<EventStore, "record">,
) =>
  Effect.gen(function* () {
    const subscription = yield* subscribe;
    const save = ({ bot, run, envelope }: BotEvent) =>
      store.record({ bot, run, turn: envelope.turn, event: envelope.event });
    const worker = yield* Effect.uninterruptibleMask((restore) =>
      restore(PubSub.take(subscription)).pipe(
        Effect.flatMap(save),
        Effect.forever,
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() =>
      Fiber.interrupt(worker).pipe(
        Effect.andThen(PubSub.remaining(subscription)),
        Effect.flatMap((queued) =>
          queued === 0
            ? Effect.void
            : PubSub.takeAll(subscription).pipe(
                Effect.flatMap((events) =>
                  Effect.forEach(events, save, { discard: true }),
                ),
              ),
        ),
      ),
    );
  });
