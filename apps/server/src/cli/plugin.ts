import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import {
  approvalToken,
  readInstall,
  recordVersion,
} from "../plugins/approvals";
import { permissionList } from "../plugins/grants";
import { readManifest } from "../plugins/manifest-file";
import { filesDigest } from "../plugins/tree-digest";
import { withFilesLock } from "../plugins/updates/files-lock";
import { UpdateRefused } from "../plugins/updates/refused";
import { databaseFile, withStore } from "./device";
import { failed } from "./failure";
import { CliIo } from "./io";

const installedVersion = (stateDir: string, plugin: string) =>
  existsSync(join(stateDir, databaseFile))
    ? withStore(stateDir, (db) =>
        Effect.sync(() => readInstall(db, plugin)?.current.version),
      )
    : Effect.succeed(undefined);

const managedBy = (pluginsDir: string, folder: string) => {
  let root: string;
  try {
    root = realpathSync(pluginsDir);
  } catch {
    return undefined;
  }
  const path = relative(root, folder);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    return undefined;
  }
  const [top = ""] = path.split(sep);
  if (top === ".staging") return "inside .staging, where plugin update unpacks";
  if (top.includes("@")) return "a release folder that plugin update manages";
  return undefined;
};

export const pluginInstall = (options: {
  readonly stateDir: string;
  readonly pluginsDir: string;
  readonly folder: string;
  readonly approve: string | undefined;
}) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const result = yield* Effect.result(readManifest(resolve(options.folder)));
    if (result._tag === "Failure") {
      for (const issue of result.failure.issues) {
        yield* io.err(`Plugin manifest: ${issue.message}`);
      }
      return yield* failed;
    }
    const { manifest, folder } = result.success;
    const managed = managedBy(options.pluginsDir, folder);
    if (managed !== undefined) {
      yield* io.err(
        `${folder} is ${managed}, so it can't be installed as a folder. Copy it to another folder first.`,
      );
      return yield* failed;
    }
    const digest = yield* Effect.result(filesDigest(folder));
    if (digest._tag === "Failure") {
      yield* io.err(`Plugin files: ${digest.failure.reason}.`);
      return yield* failed;
    }
    const permissions = permissionList(manifest);
    const tokenFrom = (fromVersion: string | undefined) =>
      approvalToken({
        id: manifest.id,
        fromVersion,
        version: manifest.version,
        folder,
        permissions,
        filesDigest: digest.success,
      });
    const fromVersion = yield* installedVersion(options.stateDir, manifest.id);
    const approval = tokenFrom(fromVersion);
    yield* io.out(
      `Plugin ${manifest.id} ${manifest.version} at ${JSON.stringify(folder)}`,
    );
    if (fromVersion !== undefined) {
      yield* io.out(`Replaces the approved version ${fromVersion}`);
    }
    for (const { kind, name } of permissions) {
      yield* io.out(`${kind}\t${JSON.stringify(name)}`);
    }
    if (permissions.length === 0) yield* io.out("No permissions requested.");
    if (options.approve === undefined) {
      yield* io.out(
        `Review the permissions above. To approve this plugin's files and grant them all, repeat the command with --approve ${approval}`,
      );
      return;
    }
    const { approve } = options;
    const save = withFilesLock(
      options.stateDir,
      withStore(options.stateDir, (db) =>
        Effect.sync(() =>
          db.transaction(() => {
            const installed = readInstall(db, manifest.id)?.current.version;
            if (tokenFrom(installed) !== approve) return false;
            recordVersion(db, {
              plugin: manifest.id,
              version: manifest.version,
              source: "folder",
              folder,
              filesDigest: digest.success,
              repository: manifest.repository,
              grants: permissions,
            });
            return true;
          }),
        ),
      ),
    ).pipe(
      Effect.catch((error) =>
        error instanceof UpdateRefused
          ? Effect.andThen(io.err(error.reason), Effect.fail(failed))
          : Effect.fail(error),
      ),
    );
    const saved = approve === approval && (yield* save);
    if (!saved) {
      yield* io.err(
        "The approval does not match this plugin's files, permissions or installed version. Preview the plugin again.",
      );
      return yield* failed;
    }
    yield* io.out("Plugin approved.");
  });
