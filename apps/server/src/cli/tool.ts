import { readFile } from "node:fs/promises";
import { Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";
import { z } from "zod";
import { withFilesLock } from "../plugins/updates/files-lock";
import { UpdateRefused } from "../plugins/updates/refused";
import {
  installTool,
  removeTool,
  ToolRefused,
  toolStatus,
  updateTool,
  type UpdateOutcome,
} from "../tools/install";
import {
  buildFor,
  parseToolList,
  processorFor,
  toolName,
  type Processor,
  type Tool,
  type ToolList,
  type ToolName,
} from "../tools/list";
import { checkState, lookupLatest, type Fetcher } from "../tools/vendor-latest";
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
      yield* io.out("NAME\tVERSION\tINSTALLED\tSTATE\tSTATUS-COMMAND");
      for (const tool of list.tools) {
        const { state, installed } = yield* Effect.promise(() =>
          toolStatus(options.toolsDir, tool, here),
        );
        const status = tool.status?.join(" ") ?? "-";
        yield* io.out(
          `${tool.name}\t${tool.version}\t${installed ?? "-"}\t${state}\t${status}`,
        );
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
      );
      yield* io.out(
        outcome === "installed"
          ? `Installed ${tool.name} ${tool.version}.`
          : `${tool.name} ${tool.version} is already installed.`,
      );
      yield* io.out(`Sign in as aphelion-bot with: ${tool.signIn.join(" ")}`);
    }),
  );

const updateLine = (name: ToolName, outcome: UpdateOutcome) => {
  switch (outcome.kind) {
    case "updated":
      return `updated ${name} ${outcome.from} -> ${outcome.to}`;
    case "current":
      return `${name} is up to date (${outcome.version})`;
    case "not installed":
      return `${name} isn't installed`;
  }
};

const updateOne = (
  stateDir: string,
  toolsDir: string,
  tool: Tool,
  here: Processor,
) =>
  Effect.gen(function* () {
    const found = buildFor(tool, here);
    if (found.kind === "unavailable") {
      return `${tool.name} has no build for this processor`;
    }
    const outcome = yield* withFilesLock(
      stateDir,
      updateTool(toolsDir, tool, found.build),
    );
    return updateLine(tool.name, outcome);
  });

export const toolUpdate = (
  options: {
    readonly stateDir: string;
    readonly toolsDir: string;
    readonly name?: ToolName | undefined;
  },
  listFile: string,
) =>
  refusedAsFailure(
    Effect.gen(function* () {
      const io = yield* CliIo;
      const list = yield* readList(listFile);
      const here = yield* processor;
      if (options.name !== undefined) {
        const tool = onList(list, options.name);
        if (tool === undefined) {
          return yield* Effect.fail(
            new ToolRefused({
              reason: `${options.name} isn't on the list of AI tools this Aphelion can install.`,
            }),
          );
        }
        return yield* io.out(
          yield* updateOne(options.stateDir, options.toolsDir, tool, here),
        );
      }
      let refused = 0;
      for (const tool of list.tools) {
        const line = yield* updateOne(
          options.stateDir,
          options.toolsDir,
          tool,
          here,
        ).pipe(
          Effect.catch((error) =>
            error instanceof ToolRefused || error instanceof UpdateRefused
              ? Effect.succeed(error)
              : Effect.fail(error),
          ),
        );
        if (typeof line === "string") {
          yield* io.out(line);
        } else {
          refused += 1;
          yield* io.err(`${tool.name}: ${line.reason}`);
        }
      }
      if (refused > 0) return yield* failed;
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
      );
      yield* io.out(
        outcome === "removed"
          ? `Removed ${options.name}. Its sign-in in the bots volume is still there.`
          : `${options.name} isn't installed.`,
      );
    }),
  );

export const toolCheck = (listFile: string, fetcher: Fetcher) =>
  refusedAsFailure(
    Effect.gen(function* () {
      const io = yield* CliIo;
      const list = yield* readList(listFile);
      const found = yield* Effect.promise(() =>
        Promise.all(list.tools.map(({ name }) => lookupLatest(name, fetcher))),
      );
      yield* io.out("NAME\tPINNED\tLATEST\tSTATE");
      let newer = false;
      let answered = 0;
      for (const [index, tool] of list.tools.entries()) {
        const latest = found[index] ?? {
          ok: false as const,
          message: "no lookup ran",
        };
        const state = checkState(tool.version, latest);
        newer ||= state === "newer version available";
        if (latest.ok) {
          answered += 1;
        } else {
          yield* io.err(`${tool.name}: ${latest.message}`);
        }
        yield* io.out(
          `${tool.name}\t${tool.version}\t${latest.ok ? latest.value : "-"}\t${state}`,
        );
      }
      if (newer) {
        yield* io.out(
          'A newer version is available. Moving to it needs a new entry in the AI tool list, which you approve. See "Update an AI tool" in the install guide.',
        );
      }
      if (list.tools.length > 0 && answered === 0) return yield* failed;
    }),
  );

const toolNameText = z.string().pipe(toolName);

export const toolListCommand = (
  handler: Handler<Parameters<typeof toolList>[0]>,
) =>
  Command.make("list", { toolsDir: toolsDirFlag }, handler).pipe(
    Command.withDescription(
      "List the AI tools on Aphelion's list as a tab-separated table: name, pinned version, installed version, state (installed, update available, not installed or unavailable on this processor), and the command that checks its sign-in.",
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

export const toolUpdateCommand = (
  handler: Handler<Parameters<typeof toolUpdate>[0]>,
) =>
  Command.make(
    "update",
    {
      stateDir: stateDirFlag,
      toolsDir: toolsDirFlag,
      name: Argument.optional(
        checkedArgument(operands["tool update"], "tool name", toolNameText),
      ).pipe(Argument.map(Option.getOrUndefined)),
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Install the version the list pins for NAME, or for every installed tool when no name is given, with the same checks as tool install. Prints one line per tool.",
    ),
  );

export const toolCheckCommand = (handler: Handler<Record<string, never>>) =>
  Command.make("check", {}, handler).pipe(
    Command.withDescription(
      "Ask each tool's vendor for its newest version and print it next to the pinned one. Downloads no program. A newer version still needs a new entry in the list.",
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
