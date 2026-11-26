import { Context, Effect, Exit, Layer, Scope } from "effect";
import {
  BotManager,
  botManagerLayer,
  type BotManagerOptions,
} from "../bots/manager";
import type { EventStore } from "./event-store";
import { persistBotEvents } from "./persist";

export const runBots = (options: BotManagerOptions, history: EventStore) =>
  Effect.gen(function* () {
    const botsScope = yield* Scope.make();
    const services = yield* Layer.buildWithScope(
      botManagerLayer({
        ...options,
        turns: { open: history.openTurn, end: history.endTurn },
      }),
      botsScope,
    );
    const manager = Context.get(services, BotManager);
    yield* persistBotEvents(manager.subscribe, history);
    yield* Effect.addFinalizer(() => Scope.close(botsScope, Exit.void));
    for (const bot of options.bots) yield* manager.start(bot.name);
    return manager;
  });
