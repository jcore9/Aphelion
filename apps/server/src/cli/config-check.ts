import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { checkComposePorts, formatIssue, type ConfigIssue } from "../config";
import { checkDirs, migratedNote } from "./checks";
import { failed } from "./failure";
import { CliIo } from "./io";

export const stdinLabel = "compose (stdin)";

const composeIssues = (source: string) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const file = source === "-" ? stdinLabel : source;
    const text = yield* (
      source === "-"
        ? io.stdin
        : Effect.tryPromise({
            try: () => readFile(source, "utf8"),
            catch: (error) => error as NodeJS.ErrnoException,
          })
    ).pipe(
      Effect.map((text) => ({ ok: true as const, text })),
      Effect.catch((error: NodeJS.ErrnoException) =>
        Effect.succeed({
          ok: false as const,
          issue: {
            file,
            message: `can't be read (${error.code ?? error.message})`,
          } satisfies ConfigIssue,
        }),
      ),
    );
    return text.ok ? checkComposePorts(file, text.text) : [text.issue];
  });

export const configCheck = (options: {
  readonly configDir: string;
  readonly stateDir: string;
  readonly compose: string | undefined;
}) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const checked = yield* checkDirs(options.configDir, options.stateDir);
    const compose =
      options.compose === undefined
        ? []
        : yield* composeIssues(options.compose);
    const issues = [...(checked.ok ? [] : checked.issues), ...compose];

    for (const issue of issues) yield* io.out(formatIssue(issue));
    if (issues.length > 0) {
      yield* io.err(
        `${String(issues.length)} problem${issues.length === 1 ? "" : "s"} found.`,
      );
      return yield* failed;
    }
    if (checked.ok) {
      for (const migrated of checked.migrated)
        yield* io.out(migratedNote(migrated));
    }
    yield* io.out(
      options.compose === undefined
        ? "Config OK. The Compose file wasn't checked: pass --compose to check it."
        : "Config OK, and the Compose file publishes ports only on the tailnet.",
    );
  });
