import { lstat, readdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { Cause, type Duration, Effect, Queue } from "effect";
import {
  devReplySchema,
  devSocketFile,
  maxDevLineBytes,
  type DevReply,
} from "../plugins/dev-control";
import { LineSplitter } from "../plugins/lines";
import { failed } from "./failure";
import { CliIo } from "./io";

export const folderFingerprint = (folder: string) =>
  Effect.promise(async () => {
    const entries = await readdir(folder, { recursive: true }).catch(
      () => undefined,
    );
    if (entries === undefined) return "unreadable";
    const lines = await Promise.all(
      entries.map(async (entry) => {
        const info = await lstat(join(folder, entry)).catch(() => undefined);
        return info === undefined
          ? `${entry}\tgone`
          : `${entry}\t${String(info.size)}\t${String(info.mtimeMs)}`;
      }),
    );
    return lines.sort().join("\n");
  });

export const watchForChanges = <E, R>(
  fingerprint: Effect.Effect<string>,
  onChange: Effect.Effect<void, E, R>,
  every: Duration.Input,
) =>
  Effect.gen(function* () {
    let loaded = yield* fingerprint;
    let seen = loaded;
    yield* onChange;
    for (;;) {
      yield* Effect.sleep(every);
      const now = yield* fingerprint;
      if (now !== seen) {
        seen = now;
      } else if (now !== loaded) {
        loaded = now;
        yield* onChange;
      }
    }
  });

const connect = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<Socket, Error>((resume) => {
      const socket = createConnection(path);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        socket.on("error", () => undefined);
        resume(Effect.succeed(socket));
      });
      socket.once("error", (error) => {
        resume(Effect.fail(error));
      });
    }),
    (socket) =>
      Effect.sync(() => {
        socket.destroy();
      }),
  );

const show = (message: DevReply) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    switch (message.type) {
      case "reloaded":
        return message.state === "running"
          ? yield* io.out(`Reloaded ${message.plugin}: the handshake finished.`)
          : yield* io.err(
              `Reloaded ${message.plugin}, but it isn't running: ${message.state}. The server log says why.`,
            );
      case "refused":
        return yield* io.err(`Refused: ${message.reason}`);
      case "crashed":
        return yield* io.err(
          `${message.plugin} crashed after the handshake. If its start() failed, the server log says why.`,
        );
    }
  });

const devClient = (path: string) =>
  Effect.gen(function* () {
    const socket = yield* connect(path);
    const incoming = yield* Queue.unbounded<string, Cause.Done>();
    const splitter = new LineSplitter(maxDevLineBytes);
    socket.on("data", (chunk: Buffer) => {
      for (const piece of splitter.push(chunk)) {
        if (piece.kind === "line") Queue.offerUnsafe(incoming, piece.text);
      }
    });
    socket.on("close", () => {
      Queue.endUnsafe(incoming);
    });
    const answered = yield* Queue.unbounded<undefined>();
    const read = Effect.gen(function* () {
      for (;;) {
        const line = yield* Queue.take(incoming).pipe(
          Effect.catchIf(Cause.isDone, () =>
            Effect.fail(new Error("the server closed the dev connection")),
          ),
        );
        const message = devReplySchema.safeParse(
          yield* Effect.try((): unknown => JSON.parse(line)).pipe(
            Effect.orElseSucceed(() => undefined),
          ),
        );
        if (!message.success) {
          return yield* Effect.fail(
            new Error("the server sent a reply this command can't read"),
          );
        }
        yield* show(message.data);
        if (message.data.type !== "crashed") {
          yield* Queue.offer(answered, undefined);
        }
      }
    });
    const reload = (folder: string) =>
      Effect.gen(function* () {
        socket.write(`${JSON.stringify({ type: "reload", folder })}\n`);
        yield* Queue.take(answered);
      });
    return { read, reload };
  });

export const pluginDev = (options: {
  readonly stateDir: string;
  readonly folder: string;
  readonly every?: Duration.Input;
}) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const folder = resolve(options.folder);
    const socketPath = join(options.stateDir, devSocketFile);
    const connected = yield* Effect.result(devClient(socketPath));
    if (connected._tag === "Failure") {
      yield* io.err(
        `Plugin dev mode is off: the server has no dev socket at ${socketPath}. Start Aphelion with deploy/compose.plugin-dev.yaml.`,
      );
      return yield* failed;
    }
    yield* io.out(
      `Watching ${folder}. Press Ctrl-C to stop watching. The plugin keeps running.`,
    );
    return yield* watchForChanges(
      folderFingerprint(folder),
      connected.success.reload(folder),
      options.every ?? "500 millis",
    ).pipe(Effect.raceFirst(connected.success.read));
  }).pipe(Effect.scoped);
