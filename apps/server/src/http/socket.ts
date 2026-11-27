import {
  encodeFrame,
  parseClientFrame,
  type CommandFrame,
  type Cursor,
  type ServerFrame,
} from "@aphelion/protocol";
import { Cause, Deferred, Duration, Effect, Fiber, type Scope } from "effect";
import { Socket } from "effect/socket";
import { changesState, refusal } from "../commands";
import { follow, LiveBufferFullError, type EventLog } from "../history";

export const closeReasons = {
  malformed: new Socket.CloseEvent(1007, "malformed frame"),
  "unsupported-version": new Socket.CloseEvent(1007, "unsupported version"),
  tokenEnded: new Socket.CloseEvent(1008, "token no longer valid"),
  historyFailed: new Socket.CloseEvent(1011, "history could not be read"),
  tooSlow: new Socket.CloseEvent(1013, "client too slow, reconnect"),
} as const;

type Resume = (
  cursor: Cursor | null,
) => Effect.Effect<void, never, Scope.Scope>;

type Command = (frame: CommandFrame) => Effect.Effect<void, never, Scope.Scope>;

const readFrames = (reader: Socket.Reader, resume: Resume, command: Command) =>
  Effect.gen(function* () {
    for (;;) {
      for (const message of yield* reader.pull) {
        if (typeof message !== "string") return closeReasons.malformed;
        const parsed = parseClientFrame(message);
        if (!parsed.ok) return closeReasons[parsed.error.code];
        if (parsed.frame.type === "resume") yield* resume(parsed.frame.cursor);
        else yield* command(parsed.frame);
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
  run: (frame: CommandFrame) => Effect.Effect<ServerFrame>,
  liveLimit?: number,
) =>
  Effect.gen(function* () {
    const { write } = yield* socket.writer;
    const reader = yield* socket.reader;
    const broken = yield* Deferred.make<Socket.CloseEvent>();
    let following: Fiber.Fiber<void> | undefined;

    const resume: Resume = (cursor) =>
      Effect.gen(function* () {
        if (following !== undefined) yield* Fiber.interrupt(following);
        following = yield* follow(
          log,
          cursor,
          (frame) => write(encodeFrame(frame)),
          liveLimit,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.asVoid(
              Deferred.succeed(
                broken,
                Cause.hasFails(cause) &&
                  cause.reasons.some(
                    (reason) =>
                      Cause.isFailReason(reason) &&
                      reason.error instanceof LiveBufferFullError,
                  )
                  ? closeReasons.tooSlow
                  : closeReasons.historyFailed,
              ),
            ),
          ),
          Effect.forkScoped,
        );
      });

    const command: Command = (frame) =>
      Effect.gen(function* () {
        if (changesState(frame) && !(yield* stillValid)) {
          yield* write(encodeFrame(refusal(frame, "device-revoked")));
          yield* Deferred.succeed(broken, closeReasons.tokenEnded);
          return;
        }
        yield* write(encodeFrame(yield* run(frame)));
      }).pipe(Effect.ignore, Effect.forkScoped, Effect.asVoid);

    const close = yield* Effect.raceFirst(
      Effect.raceFirst(
        readFrames(reader, resume, command),
        watchToken(stillValid, recheckEvery),
      ),
      Deferred.await(broken),
    );
    yield* write(close);
  }).pipe(
    Effect.catchTag("SocketError", () => Effect.void),
    Effect.scoped,
  );
