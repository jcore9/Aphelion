import { Effect, Layer } from "effect";
import { CliOutput, type CliError } from "effect/cli";
import { operands, options, ownText } from "./flags";
import { CliIo } from "./io";

const optionFlags: ReadonlySet<string> = new Set(
  Object.values(options).map((name) => `--${name}`),
);
const plainOption = /^--?[a-z-]+$/;
const plainWords = /^[a-z -]+$/;
const repeated = /^\d+ occurrences$/;
const fallback = "the command line can't be read";

const commandOf = (path: readonly string[]) => path.slice(1).join(" ");

export const usageMessage = (
  error: CliError.NonShowHelpErrors,
  path: readonly string[],
): string => {
  const command = commandOf(path);
  switch (error._tag) {
    case "UnrecognizedOption": {
      if (!plainOption.test(error.option)) return "unknown option";
      if (!optionFlags.has(error.option)) {
        return `unknown option ${error.option}`;
      }
      const where = commandOf(error.command ?? path) || "headless";
      return `${error.option} isn't an option of "${where}"`;
    }
    case "UnknownSubcommand": {
      const words = [...(error.parent ?? []).slice(1), error.subcommand]
        .filter((word) => word !== "")
        .join(" ");
      return plainWords.test(words)
        ? `unknown command "${words}"`
        : "unknown command";
    }
    case "UnexpectedArgument": {
      const operand = operands[command as keyof typeof operands];
      const got = (operand === undefined ? 0 : 1) + error.arguments.length;
      const takes = operand === undefined ? "no arguments" : `one ${operand}`;
      return `"${command}" takes ${takes}, but got ${String(got)}`;
    }
    case "MissingArgument":
      return `"${command}" needs a ${error.argument}`;
    case "InvalidValue": {
      if (error.expected.startsWith(ownText)) {
        const text = error.expected.slice(ownText.length);
        return error.kind === "flag"
          ? `--${error.option} ${text}`
          : `the ${text}`;
      }
      if (error.kind !== "flag") return fallback;
      return repeated.test(error.value)
        ? `--${error.option} is given twice`
        : `--${error.option} needs a value`;
    }
    default:
      return fallback;
  }
};

export const presenter = Layer.effect(CliOutput.Presenter)(
  Effect.gen(function* () {
    const io = yield* CliIo;
    const formatter = CliOutput.defaultFormatter({ colors: false });
    return {
      present: (event: CliOutput.Presenter.Event) => {
        switch (event._tag) {
          case "Help":
            return Effect.ignore(
              io.out(formatter.formatHelpDoc(event.helpDoc)),
            );
          case "Version":
            return Effect.ignore(io.out(`${event.name} ${event.version}`));
          case "InvalidInvocation": {
            const first = event.errors[0];
            return Effect.ignore(
              Effect.andThen(
                io.err(
                  `aphelion: ${first === undefined ? fallback : usageMessage(first, event.commandPath)}`,
                ),
                io.err("Run aphelion --help to see the commands."),
              ),
            );
          }
        }
      },
    };
  }),
);
