import { Cause, Effect, Layer } from "effect";
import { CliConfig, CliError, Command, GlobalFlag } from "effect/cli";
import { createLogger } from "../log";
import { version } from "../version";
import { configCheck, configCheckCommand } from "./config-check";
import {
  deviceAdd,
  deviceAddCommand,
  deviceList,
  deviceListCommand,
  deviceRevoke,
  deviceRevokeCommand,
} from "./device";
import { CliFailure, failed, usage } from "./failure";
import { headless, rootCommand } from "./headless";
import { CliIo } from "./io";
import { hint, presenter } from "./output";
import { pluginInstall, pluginInstallCommand } from "./plugin";
import { pluginDev, pluginDevCommand } from "./plugin-dev";
import { pluginEnable, pluginEnableCommand } from "./plugin-enable";
import {
  pluginRestart,
  pluginRestartCommand,
  pluginRollback,
  pluginRollbackCommand,
  pluginUpdate,
  pluginUpdateCommand,
} from "./plugin-update";
import { restoreFinish, restoreFinishCommand } from "./restore";
import {
  defaultToolListFile,
  toolInstall,
  toolCheck,
  toolCheckCommand,
  toolInstallCommand,
  toolList,
  toolListCommand,
  toolRemove,
  toolRemoveCommand,
  toolUpdate,
  toolUpdateCommand,
} from "./tool";

export { CliIo, processIo } from "./io";
export { CliFailure } from "./failure";

export interface Handlers {
  readonly headless: Parameters<typeof rootCommand>[0];
  readonly configCheck: Parameters<typeof configCheckCommand>[0];
  readonly deviceAdd: Parameters<typeof deviceAddCommand>[0];
  readonly deviceList: Parameters<typeof deviceListCommand>[0];
  readonly deviceRevoke: Parameters<typeof deviceRevokeCommand>[0];
  readonly pluginInstall: Parameters<typeof pluginInstallCommand>[0];
  readonly pluginUpdate: Parameters<typeof pluginUpdateCommand>[0];
  readonly pluginEnable: Parameters<typeof pluginEnableCommand>[0];
  readonly pluginRollback: Parameters<typeof pluginRollbackCommand>[0];
  readonly pluginRestart: Parameters<typeof pluginRestartCommand>[0];
  readonly pluginDev: Parameters<typeof pluginDevCommand>[0];
  readonly toolList: Parameters<typeof toolListCommand>[0];
  readonly toolInstall: Parameters<typeof toolInstallCommand>[0];
  readonly toolRemove: Parameters<typeof toolRemoveCommand>[0];
  readonly toolUpdate: Parameters<typeof toolUpdateCommand>[0];
  readonly toolCheck: Parameters<typeof toolCheckCommand>[0];
  readonly restoreFinish: Parameters<typeof restoreFinishCommand>[0];
}

const toolListFile = () =>
  process.env["APHELION_TOOL_LIST"] ?? defaultToolListFile;

const handlers: Handlers = {
  headless: (options) => headless(options, createLogger()),
  configCheck,
  deviceAdd,
  deviceList,
  deviceRevoke,
  pluginInstall,
  pluginUpdate: (options) =>
    pluginUpdate(options, process.env["APHELION_GITHUB_API"]),
  pluginEnable,
  pluginRollback,
  pluginRestart,
  pluginDev,
  toolList: (options) => toolList(options, toolListFile()),
  toolInstall: (options) => toolInstall(options, toolListFile()),
  toolRemove,
  toolUpdate: (options) => toolUpdate(options, toolListFile()),
  toolCheck: () => toolCheck(toolListFile(), fetch),
  restoreFinish,
};

const shortCluster = /^-[^-]/;
const shortFlags: ReadonlySet<string> = new Set(["-h", "-v"]);

const hasShortCluster = (argv: readonly string[]) =>
  argv.some((arg) => shortCluster.test(arg) && !shortFlags.has(arg));

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const group = <
  const Subcommands extends ReadonlyArray<Command.Command.SubcommandEntry>,
>(
  name: string,
  description: string,
  subcommands: Subcommands,
) =>
  Command.make(name, {}, () =>
    Effect.fail(
      new CliError.ShowHelp({
        commandPath: ["aphelion", name],
        errors: [
          new CliError.UnknownSubcommand({
            subcommand: "",
            parent: ["aphelion", name],
            suggestions: [],
          }),
        ],
      }),
    ),
  ).pipe(
    Command.withDescription(description),
    Command.withSubcommands(subcommands),
  );

export const makeCli = (handle: Handlers) => {
  const root = rootCommand(handle.headless).pipe(
    Command.withSubcommands([
      group("config", "Check the config files and folders.", [
        configCheckCommand(handle.configCheck),
      ]),
      group("device", "Add, list and revoke devices.", [
        deviceAddCommand(handle.deviceAdd),
        deviceListCommand(handle.deviceList),
        deviceRevokeCommand(handle.deviceRevoke),
      ]),
      group(
        "plugin",
        "Install, update, switch on, roll back, restart and develop plugins.",
        [
          pluginInstallCommand(handle.pluginInstall),
          pluginUpdateCommand(handle.pluginUpdate),
          pluginEnableCommand(handle.pluginEnable),
          pluginRollbackCommand(handle.pluginRollback),
          pluginRestartCommand(handle.pluginRestart),
          pluginDevCommand(handle.pluginDev),
        ],
      ),
      group("tool", "List, install, update, check and remove AI tools.", [
        toolListCommand(handle.toolList),
        toolInstallCommand(handle.toolInstall),
        toolUpdateCommand(handle.toolUpdate),
        toolCheckCommand(handle.toolCheck),
        toolRemoveCommand(handle.toolRemove),
      ]),
      group("restore", "Finish a restore from a backup.", [
        restoreFinishCommand(handle.restoreFinish),
      ]),
    ]),
  );
  const parse = Command.runWith(root, { version });
  const settings = Layer.merge(
    CliConfig.layer({ builtIns: [GlobalFlag.Help, GlobalFlag.Version] }),
    presenter,
  );
  return (argv: readonly string[]) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      if (hasShortCluster(argv)) {
        yield* Effect.ignore(
          Effect.andThen(io.err("aphelion: unknown option"), io.err(hint)),
        );
        return yield* Effect.fail(usage);
      }
      return yield* parse(argv).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause);
          if (CliError.isCliError(error) && error._tag === "ShowHelp") {
            return error.errors.length > 0 ? Effect.fail(usage) : Effect.void;
          }
          if (Cause.hasInterruptsOnly(cause) || error instanceof CliFailure) {
            return Effect.failCause(cause);
          }
          return Effect.andThen(
            Effect.ignore(io.err(`aphelion: ${describe(cause)}`)),
            Effect.fail(failed),
          );
        }),
      );
    }).pipe(Effect.provide(settings));
};

export const cli = makeCli(handlers);
