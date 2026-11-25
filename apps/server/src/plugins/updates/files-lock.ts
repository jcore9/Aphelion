import { join } from "node:path";
import { Effect } from "effect";
import { lockFile } from "../../adapters/file-lock";
import { UpdateRefused } from "./refused";

export const filesLockFile = "plugin-files.lock";

export const withFilesLock = <A, E, R>(
  stateDir: string,
  use: Effect.Effect<A, E, R>,
  busy = "Another plugin install, update or rollback is running, so try again when it finishes.",
) =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => lockFile(join(stateDir, filesLockFile)),
      catch: (error) =>
        new Error(`can't lock the plugin files: ${String(error)}`),
    }).pipe(
      Effect.flatMap((lock) =>
        lock.kind === "held"
          ? Effect.fail(
              new UpdateRefused({
                reason: busy,
              }),
            )
          : Effect.succeed(lock),
      ),
    ),
    () => use,
    (lock) =>
      Effect.sync(() => {
        lock.release();
      }),
  );
