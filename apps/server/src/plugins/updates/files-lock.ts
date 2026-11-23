import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { UpdateRefused } from "./refused";

export const filesLockFile = "plugin-files.lock";

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) === "EPERM";
  }
}

async function take(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const pid = Number(await readFile(path, "utf8").catch(() => ""));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
      throw new UpdateRefused({
        reason: `Another plugin install, update or rollback is running (process ${String(pid)}), so try again when it finishes.`,
      });
    }
    await unlink(path).catch(() => undefined);
  }
  throw new UpdateRefused({
    reason: `${path} keeps coming back, so try again in a moment.`,
  });
}

export const withFilesLock = <A, E, R>(
  stateDir: string,
  use: Effect.Effect<A, E, R>,
) => {
  const path = join(stateDir, filesLockFile);
  return Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => take(path),
      catch: (error) =>
        error instanceof UpdateRefused
          ? error
          : new Error(`can't lock the plugin files: ${String(error)}`),
    }),
    () => use,
    () => Effect.promise(() => unlink(path).catch(() => undefined)),
  );
};
