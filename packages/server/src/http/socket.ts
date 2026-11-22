import { parseClientFrame } from "@aphelion/protocol";
import { Duration, Effect } from "effect";
import { Socket } from "effect/socket";

export const closeReasons = {
  malformed: new Socket.CloseEvent(1007, "malformed frame"),
  "unsupported-version": new Socket.CloseEvent(1007, "unsupported version"),
  tokenEnded: new Socket.CloseEvent(1008, "token no longer valid"),
} as const;

const readFrames = (reader: Socket.Reader) =>
  Effect.gen(function* () {
    for (;;) {
      for (const message of yield* reader.pull) {
        if (typeof message !== "string") return closeReasons.malformed;
        const parsed = parseClientFrame(message);
        if (!parsed.ok) return closeReasons[parsed.error.code];
      }
    }
  });

const watchToken = (
  stillValid: Effect.Effect<boolean>,
  every: Duration.Duration,
) =>
  Effect.gen(function* () {
    while (yield* stillValid) yield* Effect.sleep(every);
    return closeReasons.tokenEnded;
  });

export const serveSocket = (
  socket: Socket.Socket,
  stillValid: Effect.Effect<boolean>,
  recheckEvery: Duration.Duration,
) =>
  Effect.gen(function* () {
    const { write } = yield* socket.writer;
    const reader = yield* socket.reader;
    const close = yield* Effect.raceFirst(
      readFrames(reader),
      watchToken(stillValid, recheckEvery),
    );
    yield* write(close);
  }).pipe(
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.scoped,
  );
