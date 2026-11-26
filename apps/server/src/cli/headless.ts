import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  BotManager,
  botManagerLayer,
  type BotDefinition,
} from "../bots/manager";
import { botRunnerPipeLink } from "../bots/runner-pipe";
import { memorySessionRefs } from "../bots/session-refs";
import { formatIssue } from "../config";
import { serveHttp } from "../http";
import type { Logger } from "../log";
import { installedPlugins, readInstall } from "../plugins/approvals";
import {
  controlSocketFile,
  pluginControl,
  serveControlSocket,
} from "../plugins/control";
import { sqlitePluginGrants } from "../plugins/grants";
import { PluginHost, pluginHostLayer } from "../plugins/host";
import { runnerPipeLink, type RunnerPipeFds } from "../plugins/runner-pipe";
import type { Database } from "../store";
import { version } from "../version";
import { checkDirs, migratedNote } from "./checks";
import { withStore } from "./device";
import { failed } from "./failure";

interface PluginOptions {
  readonly fds: RunnerPipeFds;
  readonly stateDir: string;
  readonly devFolder: string | undefined;
}

const startPlugins = (
  db: Database,
  { fds, stateDir, devFolder }: PluginOptions,
  logger: Logger,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      pluginHostLayer({ logger }).pipe(
        Layer.provide(
          Layer.mergeAll(runnerPipeLink(fds, logger), sqlitePluginGrants(db)),
        ),
      ),
    );
    const control = yield* pluginControl({
      devFolder,
      installs: () => installedPlugins(db),
      install: (plugin) => readInstall(db, plugin),
    }).pipe(
      Effect.provideService(PluginHost, Context.get(services, PluginHost)),
    );
    yield* serveControlSocket(
      join(stateDir, controlSocketFile),
      control.handle,
      logger,
    );
    yield* control.boot(logger);
    if (devFolder !== undefined) {
      logger.info("plugin dev mode is on", { folder: devFolder });
    }
  });

const startBots = (
  bots: readonly BotDefinition[],
  fds: RunnerPipeFds,
  logger: Logger,
) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      botManagerLayer({ bots, logger }).pipe(
        Layer.provide(
          Layer.mergeAll(botRunnerPipeLink(fds, logger), memorySessionRefs),
        ),
      ),
    );
    const manager = Context.get(services, BotManager);
    for (const bot of bots) yield* manager.start(bot.name);
  });

export const headless = (
  options: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly pluginRunnerFds: RunnerPipeFds | undefined;
    readonly botRunnerFds: RunnerPipeFds | undefined;
    readonly pluginDev: string | undefined;
  },
  logger: Logger,
) =>
  Effect.gen(function* () {
    const checked = yield* checkDirs(options.configDir, options.stateDir);
    if (!checked.ok) {
      logger.error("the config check failed, so the server won't start", {
        issues: checked.issues.map(formatIssue),
      });
      return yield* failed;
    }
    for (const migrated of checked.migrated) {
      logger.warn("a config file is at an older version", {
        note: migratedNote(migrated),
      });
    }
    const { address, port } = checked.config.server;
    const fds = options.pluginRunnerFds;
    return yield* withStore(options.stateDir, (db) =>
      Effect.gen(function* () {
        yield* Layer.build(serveHttp({ address, port }, db));
        logger.info("server started", { version, address, port });
        if (fds === undefined) {
          logger.info("plugins are off: no plugin runner pipe was given");
        } else {
          yield* startPlugins(
            db,
            {
              fds,
              stateDir: options.stateDir,
              devFolder: options.pluginDev,
            },
            logger,
          );
        }
        if (options.botRunnerFds === undefined) {
          logger.info("bots are off: no bot runner pipe was given");
        } else {
          yield* startBots(
            checked.config.bots.bots,
            options.botRunnerFds,
            logger,
          );
        }
        return yield* Effect.never;
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            logger.info("server stopping");
          }),
        ),
      ),
    );
  });
