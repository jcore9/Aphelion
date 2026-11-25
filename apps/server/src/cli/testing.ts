import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Stdio,
  Terminal,
} from "effect";
import { ChildProcessSpawner } from "effect/process";
import { cli, CliFailure, CliIo } from "./index";

export const cliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

export async function run(argv: readonly string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const io = Layer.succeed(CliIo, {
    out: (line) => Effect.sync(() => void out.push(line)),
    err: (line) => Effect.sync(() => void err.push(line)),
    stdin: Effect.succeed(stdin),
  });
  const exit = await Effect.runPromiseExit(
    cli(argv).pipe(Effect.provide(Layer.merge(io, cliEnvironment))),
  );
  let code = 0;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    code = error instanceof CliFailure ? error.exitCode : -1;
  }
  return { code, out, err };
}
