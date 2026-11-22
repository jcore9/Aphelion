import { Effect, Layer } from "effect";
import { formatIssue } from "../config";
import { serveHttp } from "../http";
import type { Logger } from "../log";
import { version } from "../version";
import { checkDirs, migratedNote } from "./checks";
import { withStore } from "./device";
import { failed } from "./failure";

export const headless = (
  options: { readonly configDir: string; readonly stateDir: string },
  logger: Logger,
) =>
  Effect.gen(function* () {
    const checked = yield* checkDirs(options.configDir, options.stateDir);
    if (!checked.ok) {
      logger.error("the config check failed, so the server won't start", {
        issues: checked.issues.map(formatIssue),
      });
      return yield* failed;
    }
    for (const migrated of checked.migrated) {
      logger.warn("a config file is at an older version", {
        note: migratedNote(migrated),
      });
    }
    const { address, port } = checked.config.server;
    return yield* withStore(options.stateDir, (db) =>
      Effect.gen(function* () {
        yield* Layer.build(serveHttp({ address, port }, db));
        logger.info("server started", { version, address, port });
        return yield* Effect.never;
      }).pipe(
        Effect.scoped,
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            logger.info("server stopping");
          }),
        ),
      ),
    );
  });
