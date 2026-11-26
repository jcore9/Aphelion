import { Effect, PubSub, type Scope } from "effect";
import type { BotEvent } from "../bots/manager";
import type { EventStore } from "./event-store";

export const persistBotEvents = (
  subscribe: Effect.Effect<PubSub.Subscription<BotEvent>, never, Scope.Scope>,
  store: Pick<EventStore, "record">,
) =>
  Effect.gen(function* () {
    const subscription = yield* subscribe;
    yield* PubSub.take(subscription).pipe(
      Effect.flatMap(({ bot, envelope }) =>
        store.record({ bot, turn: envelope.turn, event: envelope.event }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  });
