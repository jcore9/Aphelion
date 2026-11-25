import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import {
  checkComposePorts,
  checkServerListener,
  composeListener,
  configAreas,
  formatIssue,
  type ConfigIssue,
} from "../config";
import { checkDirs, migratedNote } from "./checks";
import { failed } from "./failure";
import { CliIo } from "./io";

export const stdinLabel = "compose (stdin)";

const composeIssues = (source: string, serverPort: number | undefined) =>
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
    return text.ok
      ? checkComposePorts(file, text.text, serverPort)
      : [text.issue];
  });

export const configCheck = (options: {
  readonly configDir: string;
  readonly stateDir: string;
  readonly compose: string | undefined;
}) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const checked = yield* checkDirs(options.configDir, options.stateDir);
    const serverPort = checked.ok ? checked.config.server.port : undefined;
    const listener =
      options.compose !== undefined && checked.ok
        ? checkServerListener(
            join(options.configDir, configAreas.server.file),
            checked.config.server,
          )
        : [];
    const compose =
      options.compose === undefined
        ? []
        : yield* composeIssues(options.compose, serverPort);
    const issues = [
      ...(checked.ok ? [] : checked.issues),
      ...listener,
      ...compose,
    ];

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
        : `Config OK. The Compose file publishes ports only on the tailnet, and server.yaml sets address ${composeListener.address} and port ${String(composeListener.port)}.`,
    );
  });
