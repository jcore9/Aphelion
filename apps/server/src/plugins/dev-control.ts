import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { Effect, Option, Semaphore } from "effect";
import { z } from "zod";
import type { Logger } from "../log";
import type { Installed } from "./grants";
import { PluginHost } from "./host";
import { LineSplitter } from "./lines";
import { readManifest } from "./manifest-file";

export const devSocketFile = "plugin-dev.sock";
export const maxDevLineBytes = 64 * 1024;

export const devRequestSchema = z.strictObject({
  type: z.literal("reload"),
  folder: z.string().min(1).max(4096),
});

export const devReplySchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    plugin: z.string(),
    state: z.string(),
  }),
  z.strictObject({ ok: z.literal(false), reason: z.string() }),
]);

export type DevReply = z.infer<typeof devReplySchema>;

export interface DevControlOptions {
  readonly folder: string;
  readonly approvals: () => readonly Installed[];
}

const refuse = (reason: string): DevReply => ({ ok: false, reason });

const canonical = (path: string) =>
  isAbsolute(path)
    ? Effect.tryPromise(() => realpath(path)).pipe(Effect.option)
    : Effect.succeedNone;

export const devControl = (options: DevControlOptions) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    const lock = yield* Semaphore.make(1);

    const reload = (folder: string) =>
      Effect.gen(function* () {
        const devFolder = yield* canonical(options.folder);
        const requested = yield* canonical(folder);
        if (
          Option.isNone(devFolder) ||
          Option.isNone(requested) ||
          requested.value !== devFolder.value
        ) {
          return refuse(
            `dev mode reloads only ${options.folder}, not ${JSON.stringify(folder)}`,
          );
        }
        const approved = options
          .approvals()
          .filter((row) => row.folder === devFolder.value);
        const notApproved = refuse(
          `${options.folder} isn't approved. Run aphelion plugin install ${options.folder} and approve it.`,
        );
        if (approved.length === 0) return notApproved;
        yield* Effect.forEach(approved, (row) => host.stop(row.plugin), {
          discard: true,
        });
        const loaded = yield* Effect.result(readManifest(devFolder.value));
        if (loaded._tag === "Failure") {
          return refuse(
            `the plugin stays stopped: ${loaded.failure.issues.map((issue) => issue.message).join(" ")}`,
          );
        }
        const id = loaded.success.manifest.id;
        const approval = approved.find((row) => row.plugin === id);
        if (!approval) return notApproved;
        const before = (yield* host.status(id))?.run ?? 0;
        const started = yield* Effect.result(
          host.start(devFolder.value, { id, digest: approval.digest }),
        );
        if (started._tag === "Failure") {
          return refuse(
            `${id} stays stopped: ${started.failure.issues.map((issue) => issue.message).join(" ")}`,
          );
        }
        if (started.success.kind === "client only") {
          return refuse(`${id} has no server part to run`);
        }
        const waited = yield* host
          .waitFor(
            id,
            (state) => state.run > before && state.state !== "starting",
          )
          .pipe(Effect.timeoutOption("15 seconds"), Effect.result);
        if (waited._tag === "Failure") {
          return refuse(
            `${id} can't run: the plugin runner stopped. Restart Aphelion.`,
          );
        }
        const settled = waited.success;
        const state = Option.isSome(settled)
          ? settled.value
          : yield* host.status(id);
        return {
          ok: true,
          plugin: id,
          state: state?.state ?? "unknown",
        } as const;
      }).pipe(lock.withPermits(1));

    return (line: string): Effect.Effect<DevReply> => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        return Effect.succeed(refuse("the request isn't JSON"));
      }
      const request = devRequestSchema.safeParse(data);
      return request.success
        ? reload(request.data.folder)
        : Effect.succeed(refuse("the request isn't a reload request"));
    };
  });

const attempt = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({
    try: work,
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const removeStaleSocket = (path: string) =>
  attempt(async () => {
    const info = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (!info.isSocket()) {
      throw new Error(`${path} exists and isn't a socket`);
    }
    await unlink(path);
  });

export const serveDevSocket = (
  path: string,
  handle: (line: string) => Effect.Effect<DevReply>,
  logger: Logger,
) =>
  Effect.gen(function* () {
    yield* removeStaleSocket(path);
    const connections = new Set<Socket>();
    const server = createServer((socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      socket.on("error", () => undefined);
      const splitter = new LineSplitter(maxDevLineBytes);
      let busy = false;
      const answer = (reply: DevReply) => {
        if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
      };
      const hangUp = (reason: string) => {
        answer(refuse(reason));
        socket.end();
        socket.removeAllListeners("data");
      };
      socket.on("data", (chunk: Buffer) => {
        for (const piece of splitter.push(chunk)) {
          if (piece.kind !== "line") {
            hangUp("the request is too long");
            return;
          }
          if (busy) {
            hangUp("wait for the reply to your last request");
            return;
          }
          busy = true;
          void Effect.runPromise(handle(piece.text)).then((reply) => {
            busy = false;
            answer(reply);
          });
        }
      });
    });
    yield* Effect.acquireRelease(
      Effect.callback<undefined, Error>((resume) => {
        server.once("error", (error) => {
          resume(Effect.fail(error));
        });
        server.listen(path, () => {
          resume(Effect.succeed(undefined));
        });
      }),
      () =>
        Effect.promise(async () => {
          for (const socket of connections) socket.destroy();
          await new Promise((done) => server.close(done));
          await unlink(path).catch(() => undefined);
        }),
    );
    yield* attempt(() => chmod(path, 0o600));
    logger.info("plugin dev mode is on", { socket: path });
  });
