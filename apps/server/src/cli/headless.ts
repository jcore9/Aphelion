import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { CliError, Command, Flag } from "effect/cli";
import { z } from "zod";
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
import {
  absolutePath,
  checkedFlag,
  configDirFlag,
  optionalFlag,
  options,
  stateDirFlag,
  type Handler,
} from "./flags";

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

export const headless = (
  options: {
    readonly configDir: string;
    readonly stateDir: string;
    readonly pluginRunnerFds: RunnerPipeFds | undefined;
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

const pluginRunnerFds = z
  .string()
  .regex(/^\d{1,4},\d{1,4}$/, {
    error: "must be two file descriptor numbers, such as 3,4",
  })
  .transform((text) => {
    const [replies = 0, requests = 0] = text.split(",").map(Number);
    return { replies, requests };
  })
  .refine(({ replies, requests }) => replies >= 3 && requests >= 3, {
    error:
      "must name descriptors from 3 up, after standard input, output and error",
  })
  .refine(({ replies, requests }) => replies !== requests, {
    error: "must name two different descriptors",
  });

export const rootCommand = (handler: Handler<Parameters<typeof headless>[0]>) =>
  Command.make(
    "aphelion",
    {
      headless: Flag.Boolean(options.headless).pipe(
        Flag.withDefault(false),
        Flag.withDescription("Start the server. The container runs this"),
      ),
      configDir: configDirFlag,
      stateDir: stateDirFlag,
      pluginRunnerFds: optionalFlag(
        checkedFlag(options.pluginRunnerFds, pluginRunnerFds).pipe(
          Flag.withDescription(
            "Descriptors REPLIES,REQUESTS of the plugin runner's pipes. The server starts every installed plugin",
          ),
        ),
      ),
      pluginDev: optionalFlag(
        checkedFlag(options.pluginDev, absolutePath).pipe(
          Flag.withDescription(
            "Let plugin dev reload the approved plugin in this folder",
          ),
        ),
      ),
    },
    ({ headless: serve, ...config }) =>
      serve
        ? handler(config)
        : Effect.fail(
            new CliError.ShowHelp({ commandPath: ["aphelion"], errors: [] }),
          ),
  ).pipe(
    Command.withDescription(
      "Aphelion server and command line. Run it with --headless to start the server, or with a command below.",
    ),
  );
