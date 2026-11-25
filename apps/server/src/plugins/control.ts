import { chmod, lstat, realpath, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { Duration, Effect, Fiber, Option, Semaphore } from "effect";
import { z } from "zod";
import type { Logger } from "../log";
import {
  approvalFor,
  switchedOffMessage,
  type InstallRecord,
} from "./approvals";
import { PluginHost } from "./host";
import type { LifecycleState } from "./lifecycle";
import { LineSplitter } from "./lines";
import { readManifest } from "./manifest-file";

export const controlSocketFile = "plugin-control.sock";
export const maxControlLineBytes = 64 * 1024;
export const devModeOff = "dev mode is off";
export const noServerPart = (plugin: string) =>
  `${plugin} has no server part to run`;
export const restartWatch: Duration.Input = "10 seconds";

export const controlRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("restart"),
    plugin: z.string().min(1).max(256),
  }),
  z.strictObject({
    type: z.literal("reload"),
    folder: z.string().min(1).max(4096),
  }),
]);

export const controlReplySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("restarted"),
    plugin: z.string(),
    state: z.string(),
  }),
  z.strictObject({
    type: z.literal("reloaded"),
    plugin: z.string(),
    state: z.string(),
  }),
  z.strictObject({ type: z.literal("refused"), reason: z.string() }),
  z.strictObject({ type: z.literal("crashed"), plugin: z.string() }),
]);

export type ControlReply = z.infer<typeof controlReplySchema>;

export interface ControlResult {
  readonly reply: ControlReply;
  readonly notice?: Effect.Effect<ControlReply | undefined>;
}

export interface ControlOptions {
  readonly devFolder: string | undefined;
  readonly installs: () => readonly InstallRecord[];
  readonly install: (plugin: string) => InstallRecord | undefined;
  readonly restartWatch?: Duration.Input;
}

const refuse = (reason: string): ControlReply => ({ type: "refused", reason });

const refused = (reason: string): ControlResult => ({ reply: refuse(reason) });

const crashed = (state: LifecycleState) =>
  state.state === "crashed" ||
  (state.state === "stopped" && state.reason === "crashed too often");

export const canonical = (path: string) =>
  isAbsolute(path)
    ? Effect.tryPromise(() => realpath(path)).pipe(Effect.option)
    : Effect.succeedNone;

export const pluginControl = (options: ControlOptions) =>
  Effect.gen(function* () {
    const host = yield* PluginHost;
    const lock = yield* Semaphore.make(1);
    const devFolder =
      options.devFolder === undefined
        ? Effect.succeed(undefined)
        : canonical(options.devFolder).pipe(Effect.map(Option.getOrUndefined));

    const crashNotice = (plugin: string, run: number) =>
      host
        .waitFor(
          plugin,
          (state) => state.run !== run || state.state !== "running",
        )
        .pipe(
          Effect.map((state): ControlReply | undefined =>
            state?.run === run && crashed(state)
              ? { type: "crashed", plugin }
              : undefined,
          ),
          Effect.catchTag("RunnerClosed", () => Effect.succeed(undefined)),
        );

    const watchRunning = (plugin: string, running: LifecycleState) =>
      host
        .waitFor(
          plugin,
          (state) => state.run !== running.run || state.state !== "running",
        )
        .pipe(
          Effect.timeoutOption(options.restartWatch ?? restartWatch),
          Effect.map((left) =>
            Option.isSome(left) && left.value !== undefined
              ? left.value
              : running,
          ),
        );

    const startSettled = (
      record: InstallRecord,
      dev: string | undefined,
      type: "restarted" | "reloaded",
    ) =>
      Effect.gen(function* () {
        const id = record.plugin;
        if (!record.enabled) return refused(switchedOffMessage(id));
        const before = (yield* host.status(id))?.run ?? 0;
        const started = yield* Effect.result(
          host.start(record.current.folder, approvalFor(record, dev)),
        );
        if (started._tag === "Failure") {
          return refused(
            `${id} stays stopped: ${started.failure.issues.map((issue) => issue.message).join(" ")}`,
          );
        }
        if (started.success.kind === "client only") {
          return refused(noServerPart(id));
        }
        const settled = yield* host
          .waitFor(
            id,
            (state) => state.run > before && state.state !== "starting",
          )
          .pipe(Effect.timeoutOption("15 seconds"));
        const reached = Option.isSome(settled)
          ? settled.value
          : yield* host.status(id);
        const seen =
          type === "restarted" && reached?.state === "running"
            ? yield* watchRunning(id, reached)
            : reached;
        const reply: ControlReply = {
          type,
          plugin: id,
          state: seen?.state ?? "unknown",
        };
        if (seen?.state === "running") {
          return { reply, notice: crashNotice(id, seen.run) };
        }
        return { reply };
      }).pipe(
        Effect.catchTag("RunnerClosed", () =>
          Effect.succeed(
            refused(
              `${record.plugin} can't run: the plugin runner stopped. Restart Aphelion.`,
            ),
          ),
        ),
      );

    const restart = (plugin: string) =>
      Effect.gen(function* () {
        const record = options.install(plugin);
        if (!record) return refused(`${plugin} isn't installed`);
        yield* host.stop(plugin);
        return yield* startSettled(record, yield* devFolder, "restarted");
      });

    const reload = (path: string, folder: string) =>
      Effect.gen(function* () {
        const dev = yield* devFolder;
        const requested = yield* canonical(path);
        if (
          dev === undefined ||
          Option.isNone(requested) ||
          requested.value !== dev
        ) {
          return refused(
            `dev mode reloads only ${folder}, not ${JSON.stringify(path)}`,
          );
        }
        const approved = options
          .installs()
          .filter((record) => record.current.folder === dev);
        const notApproved = refused(
          `${folder} isn't approved. Run aphelion plugin install ${folder} and approve it.`,
        );
        if (approved.length === 0) return notApproved;
        yield* Effect.forEach(approved, (record) => host.stop(record.plugin), {
          discard: true,
        });
        const loaded = yield* Effect.result(readManifest(dev));
        if (loaded._tag === "Failure") {
          return refused(
            `the plugin stays stopped: ${loaded.failure.issues.map((issue) => issue.message).join(" ")}`,
          );
        }
        const record = approved.find(
          (row) => row.plugin === loaded.success.manifest.id,
        );
        if (!record) return notApproved;
        return yield* startSettled(record, dev, "reloaded");
      });

    const boot = (logger: Logger) =>
      Effect.gen(function* () {
        const dev = yield* devFolder;
        const plugins = options.installs().map((record) => record.plugin);
        for (const plugin of plugins) {
          const record = options.install(plugin);
          if (!record) continue;
          if (!record.enabled) {
            logger.info("a switched-off plugin was not started", { plugin });
            continue;
          }
          const { folder } = record.current;
          const started = yield* Effect.result(
            host.start(folder, approvalFor(record, dev)),
          );
          if (started._tag === "Failure") {
            logger.error("an installed plugin was refused at startup", {
              plugin,
              folder,
              issues: started.failure.issues.map((issue) => issue.message),
            });
          }
        }
        logger.info("plugin host started", { installed: plugins.length });
      }).pipe(lock.withPermits(1));

    const handle = (line: string): Effect.Effect<ControlResult> => {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        return Effect.succeed(refused("the request isn't JSON"));
      }
      const request = controlRequestSchema.safeParse(data);
      if (!request.success) {
        return Effect.succeed(
          refused("the request isn't a restart or reload request"),
        );
      }
      const { data: parsed } = request;
      if (parsed.type === "restart") {
        return restart(parsed.plugin).pipe(lock.withPermits(1));
      }
      const folder = options.devFolder;
      return folder === undefined
        ? Effect.succeed(refused(devModeOff))
        : reload(parsed.folder, folder).pipe(lock.withPermits(1));
    };

    return { handle, boot };
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

export const serveControlSocket = (
  path: string,
  handle: (line: string) => Effect.Effect<ControlResult>,
  logger: Logger,
) =>
  Effect.gen(function* () {
    yield* removeStaleSocket(path);
    const connections = new Set<Socket>();
    const watches = new Set<Fiber.Fiber<void>>();
    const stopWatch = (watch: Fiber.Fiber<void> | undefined) => {
      if (!watch) return;
      watches.delete(watch);
      void Effect.runPromise(Fiber.interrupt(watch));
    };
    const server = createServer((socket) => {
      connections.add(socket);
      const splitter = new LineSplitter(maxControlLineBytes);
      let busy = false;
      let closed = false;
      let watch: Fiber.Fiber<void> | undefined;
      const answer = (reply: ControlReply) => {
        if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
      };
      const hangUp = (reason: string) => {
        answer(refuse(reason));
        socket.end();
        socket.removeAllListeners("data");
      };
      const startWatch = (notice: Effect.Effect<ControlReply | undefined>) => {
        stopWatch(watch);
        const fiber = Effect.runFork(
          notice.pipe(
            Effect.flatMap((message) =>
              Effect.sync(() => {
                if (message) answer(message);
              }),
            ),
          ),
        );
        watch = fiber;
        watches.add(fiber);
      };
      socket.on("close", () => {
        closed = true;
        connections.delete(socket);
        stopWatch(watch);
        watch = undefined;
      });
      socket.on("error", () => undefined);
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
          stopWatch(watch);
          watch = undefined;
          void Effect.runPromise(handle(piece.text)).then((result) => {
            busy = false;
            answer(result.reply);
            if (result.notice && !closed) startWatch(result.notice);
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
          await Promise.all(
            [...watches].map((fiber) =>
              Effect.runPromise(Fiber.interrupt(fiber)),
            ),
          );
          watches.clear();
          for (const socket of connections) socket.destroy();
          await new Promise((done) => server.close(done));
          await unlink(path).catch(() => undefined);
        }),
    );
    yield* attempt(() => chmod(path, 0o600));
    logger.info("the plugin control socket is open", { socket: path });
  });
