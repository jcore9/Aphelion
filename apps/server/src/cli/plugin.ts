import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import {
  approvalToken,
  readInstall,
  recordVersion,
} from "../plugins/approvals";
import { permissionList } from "../plugins/grants";
import { readManifest } from "../plugins/manifest-file";
import { filesDigest } from "../plugins/tree-digest";
import { databaseFile, withStore } from "./device";
import { failed } from "./failure";
import { CliIo } from "./io";

const installedVersion = (stateDir: string, plugin: string) =>
  existsSync(join(stateDir, databaseFile))
    ? withStore(stateDir, (db) =>
        Effect.sync(() => readInstall(db, plugin)?.current.version),
      )
    : Effect.succeed(undefined);

export const pluginInstall = (options: {
  readonly stateDir: string;
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
    const saved =
      approve === approval &&
      (yield* withStore(options.stateDir, (db) =>
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
              repository: undefined,
              grants: permissions,
            });
            return true;
          }),
        ),
      ));
    if (!saved) {
      yield* io.err(
        "The approval does not match this plugin's files, permissions or installed version. Preview the plugin again.",
      );
      return yield* failed;
    }
    yield* io.out("Plugin approved.");
  });
