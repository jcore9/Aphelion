import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { finishRestore } from "../restore";
import { databaseFile, withStore } from "./device";
import { failed } from "./failure";
import { stateDirFlag, type Handler } from "./flags";
import { CliIo } from "./io";

export const restoreFinish = (options: { readonly stateDir: string }) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const database = join(options.stateDir, databaseFile);
    if (!existsSync(database)) {
      yield* io.err(
        `There is no database at ${database}. Restore the files first. Nothing changed.`,
      );
      return yield* failed;
    }
    const result = yield* withStore(options.stateDir, (db) =>
      Effect.sync(() => finishRestore(db)),
    );
    yield* io.out("Restore finished. Every device token is revoked.");
    for (const plugin of result.switchedOff) {
      yield* io.out(
        `Plugin ${plugin} is switched off. Switch it on: aphelion plugin enable ${plugin}`,
      );
    }
    yield* io.out("Enroll a device: aphelion device add NAME");
  });

export const restoreFinishCommand = (
  handler: Handler<Parameters<typeof restoreFinish>[0]>,
) =>
  Command.make("finish", { stateDir: stateDirFlag }, handler).pipe(
    Command.withDescription(
      "Run once after restoring a backup, before the server starts. Revokes every device token, switches every plugin off, and lists the commands that switch the plugins back on.",
    ),
  );
