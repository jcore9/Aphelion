import { Context, Data, type Effect, type Stream } from "effect";
import type { ProcessExit, SpawnFailed } from "../plugins/processes";

export interface BotSpec {
  readonly bot: string;
  readonly adapter: string;
  readonly folder: string;
}

export class KillFailed extends Data.TaggedError("KillFailed")<{
  readonly reason: string;
}> {}

export class CgroupsUnsafe extends Data.TaggedError("CgroupsUnsafe")<{
  readonly step: string;
  readonly errno: string;
}> {}

export interface BotProcess {
  readonly write: (line: string) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exited: Effect.Effect<ProcessExit>;
  readonly kill: Effect.Effect<void, KillFailed>;
}

export class BotProcesses extends Context.Service<
  BotProcesses,
  {
    readonly start: (
      spec: BotSpec,
    ) => Effect.Effect<BotProcess, SpawnFailed | CgroupsUnsafe>;
  }
>()("aphelion/bots/BotProcesses") {}
