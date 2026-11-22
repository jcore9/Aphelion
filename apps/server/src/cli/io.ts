import { text } from "node:stream/consumers";
import type { Writable } from "node:stream";
import { Context, Effect, Layer } from "effect";

export class CliIo extends Context.Service<
  CliIo,
  {
    readonly out: (line: string) => Effect.Effect<void>;
    readonly err: (line: string) => Effect.Effect<void>;
    readonly stdin: Effect.Effect<string, Error>;
  }
>()("aphelion/cli/CliIo") {}

const writeLine = (stream: Writable) => (line: string) =>
  Effect.promise(
    () =>
      new Promise<void>((done) => {
        stream.write(`${line}\n`, () => {
          done();
        });
      }),
  );

export const processIo = Layer.succeed(CliIo, {
  out: writeLine(process.stdout),
  err: writeLine(process.stderr),
  stdin: Effect.tryPromise({
    try: () => text(process.stdin),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }),
});
