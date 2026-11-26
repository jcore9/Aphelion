import { parseClientFrame, encodeFrame, type Cursor } from "@aphelion/protocol";
import { Deferred, Duration, Effect, Fiber, type Scope } from "effect";
import { Socket } from "effect/socket";
import { follow, type EventLog } from "../history";

export const closeReasons = {
  malformed: new Socket.CloseEvent(1007, "malformed frame"),
  "unsupported-version": new Socket.CloseEvent(1007, "unsupported version"),
  tokenEnded: new Socket.CloseEvent(1008, "token no longer valid"),
  historyFailed: new Socket.CloseEvent(1011, "history could not be read"),
} as const;

type Resume = (
  cursor: Cursor | null,
) => Effect.Effect<void, never, Scope.Scope>;

const readFrames = (reader: Socket.Reader, resume: Resume) =>
  Effect.gen(function* () {
    for (;;) {
      for (const message of yield* reader.pull) {
        if (typeof message !== "string") return closeReasons.malformed;
        const parsed = parseClientFrame(message);
        if (!parsed.ok) return closeReasons[parsed.error.code];
        if (parsed.frame.type === "resume") yield* resume(parsed.frame.cursor);
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
  log: EventLog,
) =>
  Effect.gen(function* () {
    const { write } = yield* socket.writer;
    const reader = yield* socket.reader;
    const broken = yield* Deferred.make<Socket.CloseEvent>();
    let following: Fiber.Fiber<void> | undefined;

    const resume: Resume = (cursor) =>
      Effect.gen(function* () {
        if (following !== undefined) yield* Fiber.interrupt(following);
        following = yield* follow(log, cursor, (frame) =>
          write(encodeFrame(frame)),
        ).pipe(
          Effect.catchCause(() =>
            Effect.asVoid(Deferred.succeed(broken, closeReasons.historyFailed)),
          ),
          Effect.forkScoped,
        );
      });

    const close = yield* Effect.raceFirst(
      Effect.raceFirst(
        readFrames(reader, resume),
        watchToken(stillValid, recheckEvery),
      ),
      Deferred.await(broken),
    );
    yield* write(close);
  }).pipe(
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.scoped,
  );
