import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { permissionList, recordGrants } from "../plugins/grants";
import { readManifest } from "../plugins/manifest-file";
import { withStore } from "./device";
import { failed } from "./failure";
import { CliIo } from "./io";

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
    const { manifest, digest, folder } = result.success;
    const permissions = permissionList(manifest);
    const approval = createHash("sha256")
      .update(JSON.stringify([folder, digest]))
      .digest("hex");
    yield* io.out(
      `Plugin ${manifest.id} ${manifest.version} at ${JSON.stringify(folder)}`,
    );
    for (const { kind, name } of permissions) {
      yield* io.out(`${kind}\t${JSON.stringify(name)}`);
    }
    if (permissions.length === 0) yield* io.out("No permissions requested.");
    if (options.approve === undefined) {
      yield* io.out(
        `Review the permissions above. To grant them all, repeat the command with --approve ${approval}`,
      );
      return;
    }
    if (options.approve !== approval) {
      yield* io.err(
        "The approval does not match this manifest. Preview the permissions again.",
      );
      return yield* failed;
    }
    yield* withStore(options.stateDir, (db) =>
      Effect.sync(() => {
        recordGrants(db, { manifest, digest, folder }, permissions);
      }),
    );
    yield* io.out("Plugin permissions saved.");
  });
