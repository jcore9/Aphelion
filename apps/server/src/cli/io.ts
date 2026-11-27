import { text } from "node:stream/consumers";
import type { Readable, Writable } from "node:stream";
import { Context, Effect, Layer } from "effect";
import {
  apiKeyFromInput,
  maxApiKeyBytes,
  type ApiKeyInput,
} from "../secrets/api-key";

export class CliIo extends Context.Service<
  CliIo,
  {
    readonly out: (line: string) => Effect.Effect<void, Error>;
    readonly err: (line: string) => Effect.Effect<void, Error>;
    readonly stdin: Effect.Effect<string, Error>;
    readonly readApiKey: (prompt: string) => Effect.Effect<ApiKeyInput, Error>;
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

export const keyInputLimit = 2 * maxApiKeyBytes;

type KeyStream = Readable & {
  readonly isTTY?: boolean;
  readonly setRawMode?: (mode: boolean) => unknown;
};

class KeyBuffer {
  readonly #bytes = new Uint8Array(keyInputLimit);
  #length = 0;

  get full(): boolean {
    return this.#length === keyInputLimit;
  }

  add(chunk: Uint8Array): void {
    const room = keyInputLimit - this.#length;
    this.#bytes.set(chunk.subarray(0, room), this.#length);
    this.#length += Math.min(room, chunk.length);
  }

  removeLastCharacter(): void {
    while (this.#length > 0) {
      this.#length -= 1;
      const byte = this.#bytes[this.#length] ?? 0;
      this.#bytes[this.#length] = 0;
      if ((byte & 0xc0) !== 0x80) return;
    }
  }

  take(): Uint8Array {
    const copy = this.#bytes.slice(0, this.#length);
    this.#bytes.fill(0);
    this.#length = 0;
    return copy;
  }
}

async function readPipe(stream: Readable): Promise<Uint8Array> {
  const buffer = new KeyBuffer();
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("standard input gave text, not bytes");
    }
    buffer.add(chunk);
    chunk.fill(0);
    if (buffer.full) break;
  }
  return buffer.take();
}

function readTerminal(
  stream: KeyStream,
  prompt: string,
  write: (text: string) => void,
): Promise<Uint8Array> {
  const buffer = new KeyBuffer();
  return new Promise<Uint8Array>((resolve, reject) => {
    const finish = (error?: Error) => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.setRawMode?.(false);
      stream.pause();
      write("\n");
      const bytes = buffer.take();
      if (error === undefined) {
        resolve(bytes);
      } else {
        bytes.fill(0);
        reject(error);
      }
    };
    const onEnd = () => {
      finish();
    };
    const onData = (chunk: Uint8Array) => {
      try {
        for (const byte of chunk) {
          if (byte === 0x0d || byte === 0x0a || byte === 0x04) {
            finish();
            return;
          }
          if (byte === 0x03) {
            finish(new Error("Stopped. No API key was read."));
            return;
          }
          if (byte === 0x7f || byte === 0x08) {
            buffer.removeLastCharacter();
          } else if (!buffer.full) {
            buffer.add(Uint8Array.of(byte));
          }
        }
      } finally {
        chunk.fill(0);
      }
    };
    stream.setRawMode?.(true);
    write(prompt);
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.resume();
  });
}

export function readKeyBytes(
  stream: KeyStream,
  prompt: string,
  write: (text: string) => void,
): Promise<Uint8Array> {
  return stream.isTTY === true
    ? readTerminal(stream, prompt, write)
    : readPipe(stream);
}

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

export const processIo = Layer.sync(CliIo, () => ({
  out: quietErrors(process.stdout),
  err: quietErrors(process.stderr),
  stdin: Effect.tryPromise({
    try: () => text(process.stdin),
    catch: asError,
  }),
  readApiKey: (prompt: string) =>
    Effect.tryPromise({
      try: () =>
        readKeyBytes(process.stdin, prompt, (line) => {
          process.stderr.write(line);
        }),
      catch: asError,
    }).pipe(Effect.map(apiKeyFromInput)),
}));
