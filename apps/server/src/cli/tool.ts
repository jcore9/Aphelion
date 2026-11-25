import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { z } from "zod";
import { withFilesLock } from "../plugins/updates/files-lock";
import { UpdateRefused } from "../plugins/updates/refused";
import {
  installTool,
  removeTool,
  ToolRefused,
  toolState,
} from "../tools/install";
import {
  buildFor,
  parseToolList,
  processorFor,
  toolName,
  type ToolList,
  type ToolName,
} from "../tools/list";
import { failed } from "./failure";
import {
  checkedArgument,
  operands,
  stateDirFlag,
  toolsDirFlag,
  type Handler,
} from "./flags";
import { CliIo } from "./io";

export const defaultToolListFile = "/usr/local/lib/aphelion/ai-tools.json";

const readList = (file: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: () =>
        new ToolRefused({ reason: `can't read the tool list ${file}` }),
    });
    const parsed = parseToolList(text);
    return parsed.ok
      ? parsed.list
      : yield* Effect.fail(new ToolRefused({ reason: parsed.message }));
  });

const refusedAsFailure = <A, R>(work: Effect.Effect<A, Error, R>) =>
  work.pipe(
    Effect.catch((error) =>
      error instanceof ToolRefused || error instanceof UpdateRefused
        ? Effect.gen(function* () {
            yield* (yield* CliIo).err(error.reason);
            return yield* failed;
          })
        : Effect.fail(error),
    ),
  );

const processor = Effect.gen(function* () {
  const found = processorFor(process.arch);
  return (
    found ??
    (yield* Effect.fail(
      new ToolRefused({
        reason: `Aphelion has no AI tool builds for the ${process.arch} processor.`,
      }),
    ))
  );
});

const onList = (list: ToolList, name: ToolName) =>
  list.tools.find((tool) => tool.name === name);

export const toolList = (
  options: { readonly toolsDir: string },
  listFile: string,
) =>
  refusedAsFailure(
    Effect.gen(function* () {
      const io = yield* CliIo;
      const list = yield* readList(listFile);
      const here = yield* processor;
      yield* io.out("NAME\tVERSION\tSTATE\tSTATUS-COMMAND");
      for (const tool of list.tools) {
        const state = yield* Effect.promise(() =>
          toolState(options.toolsDir, tool, here),
        );
        const status = tool.status?.join(" ") ?? "-";
        yield* io.out(`${tool.name}\t${tool.version}\t${state}\t${status}`);
      }
    }),
  );

export const toolInstall = (
  options: {
    readonly stateDir: string;
    readonly toolsDir: string;
    readonly name: ToolName;
  },
  listFile: string,
) =>
  refusedAsFailure(
    Effect.gen(function* () {
      const io = yield* CliIo;
      const list = yield* readList(listFile);
      const tool = onList(list, options.name);
      if (tool === undefined) {
        return yield* Effect.fail(
          new ToolRefused({
            reason: `${options.name} isn't on the list of AI tools this Aphelion can install.`,
          }),
        );
      }
      const here = yield* processor;
      const found = buildFor(tool, here);
      if (found.kind === "unavailable") {
        return yield* Effect.fail(
          new ToolRefused({
            reason: `${tool.name} ${tool.version} has no build for the ${here} processor.`,
          }),
        );
      }
      const outcome = yield* withFilesLock(
        options.stateDir,
        installTool(options.toolsDir, tool, found.build),
        "Another AI tool install or remove is running, so try again when it finishes.",
      );
      yield* io.out(
        outcome === "installed"
          ? `Installed ${tool.name} ${tool.version}.`
          : `${tool.name} ${tool.version} is already installed.`,
      );
      yield* io.out(`Sign in as aphelion-bot with: ${tool.signIn.join(" ")}`);
    }),
  );

export const toolRemove = (options: {
  readonly stateDir: string;
  readonly toolsDir: string;
  readonly name: ToolName;
}) =>
  refusedAsFailure(
    Effect.gen(function* () {
      const io = yield* CliIo;
      const outcome = yield* withFilesLock(
        options.stateDir,
        removeTool(options.toolsDir, options.name),
        "Another AI tool install or remove is running, so try again when it finishes.",
      );
      yield* io.out(
        outcome === "removed"
          ? `Removed ${options.name}. Its sign-in in the bots volume is still there.`
          : `${options.name} isn't installed.`,
      );
    }),
  );

const toolNameText = z.string().pipe(toolName);

export const toolListCommand = (
  handler: Handler<Parameters<typeof toolList>[0]>,
) =>
  Command.make("list", { toolsDir: toolsDirFlag }, handler).pipe(
    Command.withDescription(
      "List the AI tools on Aphelion's list as a tab-separated table: name, pinned version, whether it is installed, and the command that checks its sign-in.",
    ),
  );

export const toolInstallCommand = (
  handler: Handler<Parameters<typeof toolInstall>[0]>,
) =>
  Command.make(
    "install",
    {
      stateDir: stateDirFlag,
      toolsDir: toolsDirFlag,
      name: checkedArgument(
        operands["tool install"],
        "tool name",
        toolNameText,
      ),
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Download the pinned build of an AI tool from the list, check it against the list's SHA-256 and size, and install it.",
    ),
  );

export const toolRemoveCommand = (
  handler: Handler<Parameters<typeof toolRemove>[0]>,
) =>
  Command.make(
    "remove",
    {
      stateDir: stateDirFlag,
      toolsDir: toolsDirFlag,
      name: checkedArgument(operands["tool remove"], "tool name", toolNameText),
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Remove an installed AI tool. Its sign-in stays in the bots volume.",
    ),
  );
