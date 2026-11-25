import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { Data, Duration, Effect, Option } from "effect";
import {
  controlReplySchema,
  controlSocketFile,
  maxControlLineBytes,
} from "./control";
import { LineSplitter } from "./lines";

export class ControlUnreachable extends Data.TaggedError(
  "ControlUnreachable",
) {}

const unreachable = new Set(["ENOENT", "ECONNREFUSED"]);
const replySeconds = 90;

export const connectControl = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<Socket, ControlUnreachable | Error>((resume) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        socket.on("error", () => undefined);
        resume(Effect.succeed(socket));
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        resume(
          Effect.fail(
            unreachable.has(error.code ?? "")
              ? new ControlUnreachable()
              : error,
          ),
        );
      });
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );

export type RestartOutcome =
  | { readonly kind: "restarted"; readonly state: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "server not running" };

const firstLine = (socket: Socket, request: string) =>
  Effect.callback<string, Error>((resume) => {
    const splitter = new LineSplitter(maxControlLineBytes);
    socket.on("data", (chunk: Buffer) => {
      const [piece] = splitter.push(chunk);
      if (piece === undefined) return;
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      resume(
        piece.kind === "line"
          ? Effect.succeed(piece.text)
          : Effect.fail(new Error("the server's reply is too long")),
      );
    });
    socket.once("close", () => {
      resume(
        Effect.fail(new Error("the server closed the control connection")),
      );
    });
    socket.write(`${request}\n`);
  });

export const restartPlugin = (stateDir: string, plugin: string) =>
  Effect.gen(function* () {
    const connected = yield* Effect.result(
      connectControl(join(stateDir, controlSocketFile)),
    );
    if (connected._tag === "Failure") {
      if (connected.failure instanceof ControlUnreachable) {
        return { kind: "server not running" } as const;
      }
      return yield* Effect.fail(connected.failure);
    }
    const line = yield* firstLine(
      connected.success,
      JSON.stringify({ type: "restart", plugin }),
    ).pipe(Effect.timeoutOption(Duration.seconds(replySeconds)));
    if (Option.isNone(line)) {
      return yield* Effect.fail(
        new Error(
          `the server didn't answer within ${String(replySeconds)} seconds`,
        ),
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(line.value);
    } catch {
      data = undefined;
    }
    const reply = controlReplySchema.safeParse(data);
    if (reply.success && reply.data.type === "restarted") {
      return { kind: "restarted", state: reply.data.state } as const;
    }
    if (reply.success && reply.data.type === "refused") {
      return { kind: "refused", reason: reply.data.reason } as const;
    }
    return yield* Effect.fail(
      new Error("the server sent a reply this command can't read"),
    );
  }).pipe(Effect.scoped);
