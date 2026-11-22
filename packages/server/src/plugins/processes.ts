import { Context, Data, type Effect, type Stream } from "effect";

export interface SpawnSpec {
  readonly plugin: string;
  readonly folder: string;
  readonly entry: string;
  readonly dataFolder: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface PluginProcess {
  readonly write: (line: string) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exited: Effect.Effect<ProcessExit>;
  readonly kill: Effect.Effect<void>;
}

export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly reason: string;
}> {}

export class PluginProcesses extends Context.Service<
  PluginProcesses,
  {
    readonly spawn: (
      spec: SpawnSpec,
    ) => Effect.Effect<PluginProcess, SpawnFailed>;
    readonly sweep: Effect.Effect<void>;
  }
>()("aphelion/plugins/PluginProcesses") {}
