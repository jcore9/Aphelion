import type { SessionRef } from "@aphelion/plugin-sdk";
import { Context, type Effect } from "effect";

export interface SavedSession {
  readonly ref: SessionRef;
  readonly folder: string;
  readonly provider: string;
}

export class SessionRefs extends Context.Service<
  SessionRefs,
  {
    readonly get: (bot: string) => Effect.Effect<SavedSession | undefined>;
    readonly set: (bot: string, saved: SavedSession) => Effect.Effect<void>;
    readonly clear: (bot: string) => Effect.Effect<void>;
  }
>()("aphelion/bots/SessionRefs") {}
