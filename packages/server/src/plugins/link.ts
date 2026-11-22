import { Cause, Effect, Queue, Semaphore, Stream } from "effect";
import type { z } from "zod";
import { LineSplitter } from "./lines";

export interface Link<In, Out> {
  readonly incoming: Queue.Dequeue<In, Cause.Done>;
  readonly send: (message: Out) => Effect.Effect<void>;
}

export type DropReason = "too-long" | "malformed";

export interface Framing<In> {
  readonly schema: z.ZodType<In>;
  readonly maxBytes: number;
  readonly onDrop: (reason: DropReason) => Effect.Effect<void>;
}

function decode<In>(schema: z.ZodType<In>, text: string): In | undefined {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const encode = (message: unknown) => `${JSON.stringify(message)}\n`;

export const linkCapacity = 16;

export const pipeLink = <In, Out>(
  readable: ReadableStream<Uint8Array>,
  write: (text: string) => Promise<unknown> | undefined,
  framing: Framing<In>,
  sends: z.ZodType<Out>,
) =>
  Effect.gen(function* () {
    const incoming = yield* Queue.bounded<In, Cause.Done>(linkCapacity);
    const splitter = new LineSplitter(framing.maxBytes);
    const deliver = (chunk: Uint8Array) =>
      Effect.forEach(splitter.push(chunk), (piece) => {
        if (piece.kind === "too-long") return framing.onDrop("too-long");
        const message = decode(framing.schema, piece.text);
        return message === undefined
          ? framing.onDrop("malformed")
          : Queue.offer(incoming, message);
      });
    yield* Stream.fromReadableStream({
      evaluate: () => readable,
      onError: (error) => error,
    }).pipe(
      Stream.runForEach(deliver),
      Effect.ignore,
      Effect.ensuring(Queue.end(incoming)),
      Effect.forkScoped,
    );
    const writing = yield* Semaphore.make(1);
    const send = (message: Out) =>
      sends.safeParse(message).success
        ? Effect.tryPromise(async () => {
            await write(encode(message));
          }).pipe(Effect.ignore, writing.withPermits(1))
        : framing.onDrop("malformed");
    return { incoming, send } satisfies Link<In, Out>;
  });

export const memoryLinkPair = <A, B>(
  framingA: Framing<A>,
  framingB: Framing<B>,
) =>
  Effect.gen(function* () {
    const toA = yield* Queue.bounded<A, Cause.Done>(linkCapacity);
    const toB = yield* Queue.bounded<B, Cause.Done>(linkCapacity);
    const through =
      <M>(queue: Queue.Queue<M, Cause.Done>, framing: Framing<M>) =>
      (message: unknown) => {
        const text = encode(message);
        if (Buffer.byteLength(text) > framing.maxBytes) {
          return framing.onDrop("too-long");
        }
        const decoded = decode(framing.schema, text);
        return decoded === undefined
          ? framing.onDrop("malformed")
          : Queue.offer(queue, decoded).pipe(Effect.asVoid);
      };
    const a: Link<A, B> = { incoming: toA, send: through(toB, framingB) };
    const b: Link<B, A> = { incoming: toB, send: through(toA, framingA) };
    return { a, b };
  });
