import type { SessionRef } from "@aphelion/plugin-sdk";
import { Context, Effect, Layer } from "effect";

export interface SavedSession {
  readonly ref: SessionRef;
  readonly folder: string;
}

export class SessionRefs extends Context.Service<
  SessionRefs,
  {
    readonly get: (bot: string) => Effect.Effect<SavedSession | undefined>;
    readonly set: (bot: string, saved: SavedSession) => Effect.Effect<void>;
    readonly clear: (bot: string) => Effect.Effect<void>;
  }
>()("aphelion/bots/SessionRefs") {}

export const memorySessionRefs = Layer.sync(SessionRefs, () => {
  const saved = new Map<string, SavedSession>();
  return SessionRefs.of({
    get: (bot) => Effect.sync(() => saved.get(bot)),
    set: (bot, session) =>
      Effect.sync(() => {
        saved.set(bot, session);
      }),
    clear: (bot) =>
      Effect.sync(() => {
        saved.delete(bot);
      }),
  });
});
