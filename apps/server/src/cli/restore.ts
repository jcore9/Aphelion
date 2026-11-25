import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { finishRestore } from "../restore";
import { databaseFile, withStore } from "./device";
import { failed } from "./failure";
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
    if (result.kind === "enrolled-since") {
      yield* io.err(
        "restore finish already ran, and devices were enrolled since. Nothing changed.",
      );
      return yield* failed;
    }
    yield* io.out("Restore finished. Every device token is revoked.");
    for (const plugin of result.switchedOff) {
      yield* io.out(
        `Plugin ${plugin} is switched off. Switch it on: aphelion plugin enable ${plugin}`,
      );
    }
    yield* io.out("Enroll a device: aphelion device add NAME");
  });
