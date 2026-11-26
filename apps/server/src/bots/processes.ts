import { Context, type Effect, type Stream } from "effect";
import type { Cleanup, ProcessExit, SpawnFailed } from "../plugins/processes";

export interface BotSpec {
  readonly bot: string;
  readonly argv: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface BotProcess {
  readonly write: (line: string) => Effect.Effect<void>;
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly stderr: Stream.Stream<Uint8Array>;
  readonly exited: Effect.Effect<ProcessExit>;
}

export class BotProcesses extends Context.Service<
  BotProcesses,
  {
    readonly start: (spec: BotSpec) => Effect.Effect<BotProcess, SpawnFailed>;
    readonly stopAll: (bot: string) => Effect.Effect<Cleanup>;
  }
>()("aphelion/bots/BotProcesses") {}
