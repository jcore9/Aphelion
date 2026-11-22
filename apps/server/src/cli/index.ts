import { Cause, Effect } from "effect";
import { createLogger } from "../log";
import { version } from "../version";
import { parseCommandLine, type Command } from "./args";
import { configCheck } from "./config-check";
import { deviceAdd, deviceList, deviceRevoke } from "./device";
import { CliFailure, failed, usage } from "./failure";
import { headless } from "./headless";
import { helpText } from "./help";
import { CliIo } from "./io";

export { CliIo, processIo } from "./io";
export { CliFailure } from "./failure";

const run = (command: Command) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    switch (command.kind) {
      case "help":
        return yield* io.out(helpText);
      case "version":
        return yield* io.out(`aphelion ${version}`);
      case "headless":
        return yield* headless(command, createLogger());
      case "config check":
        return yield* configCheck(command);
      case "device add":
        return yield* deviceAdd(command);
      case "device list":
        return yield* deviceList(command);
      case "device revoke":
        return yield* deviceRevoke(command);
    }
  });

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const cli = (argv: readonly string[]) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const parsed = parseCommandLine(argv);
    if (!parsed.ok) {
      yield* Effect.ignore(io.err(`aphelion: ${parsed.message}`));
      yield* Effect.ignore(io.err("Run aphelion --help to see the commands."));
      return yield* usage;
    }
    return yield* run(parsed.command).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ||
        Cause.squash(cause) instanceof CliFailure
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.ignore(io.err(`aphelion: ${describe(cause)}`)),
              Effect.fail(failed),
            ),
      ),
    );
  });
