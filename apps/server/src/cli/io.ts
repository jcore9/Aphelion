import { text } from "node:stream/consumers";
import type { Writable } from "node:stream";
import { Context, Effect, Layer } from "effect";

export class CliIo extends Context.Service<
  CliIo,
  {
    readonly out: (line: string) => Effect.Effect<void, Error>;
    readonly err: (line: string) => Effect.Effect<void, Error>;
    readonly stdin: Effect.Effect<string, Error>;
  }
>()("aphelion/cli/CliIo") {}

const writeLine = (stream: Writable) => (line: string) =>
  Effect.callback<undefined, Error>((resume) => {
    stream.write(`${line}\n`, (error) => {
      resume(error ? Effect.fail(error) : Effect.succeed(undefined));
    });
  });

const quietErrors = (stream: Writable) => {
  if (stream.listenerCount("error") === 0) stream.on("error", () => undefined);
  return writeLine(stream);
};

export const processIo = Layer.sync(CliIo, () => ({
  out: quietErrors(process.stdout),
  err: quietErrors(process.stderr),
  stdin: Effect.tryPromise({
    try: () => text(process.stdin),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  }),
}));
