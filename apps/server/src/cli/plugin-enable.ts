import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { appendAudit } from "../audit";
import {
  enableToken,
  readInstall,
  switchOnPlugin,
  type InstallRecord,
} from "../plugins/approvals";
import { restartPlugin } from "../plugins/control-client";
import { filesDigest } from "../plugins/tree-digest";
import { withFilesLock } from "../plugins/updates/files-lock";
import { UpdateRefused } from "../plugins/updates/refused";
import { databaseFile, withStore } from "./device";
import { failed } from "./failure";
import {
  approveFlag,
  operandArgument,
  operands,
  stateDirFlag,
  type Handler,
} from "./flags";
import { CliIo } from "./io";

const readRecord = (stateDir: string, plugin: string) =>
  existsSync(join(stateDir, databaseFile))
    ? withStore(stateDir, (db) => Effect.sync(() => readInstall(db, plugin)))
    : Effect.succeed(undefined);

const switchOn = (stateDir: string, record: InstallRecord, token: string) =>
  withFilesLock(
    stateDir,
    withStore(stateDir, (db) =>
      Effect.sync(() =>
        db.transaction(() => {
          const now = readInstall(db, record.plugin);
          if (now === undefined || enableToken(now.current) !== token) {
            return false;
          }
          if (switchOnPlugin(db, record.plugin)) {
            appendAudit(db, {
              actor: { kind: "cli" },
              action: "plugin.enable",
              outcome: "succeeded",
              detail: { plugin: record.plugin, version: now.current.version },
            });
          }
          return true;
        }),
      ),
    ),
  );

export const pluginEnable = (options: {
  readonly stateDir: string;
  readonly plugin: string;
  readonly approve: string | undefined;
}) =>
  Effect.gen(function* () {
    const io = yield* CliIo;
    const { plugin, approve, stateDir } = options;
    const record = yield* readRecord(stateDir, plugin);
    if (record === undefined) {
      yield* io.err(`${plugin} isn't installed.`);
      return yield* failed;
    }
    if (record.enabled) {
      yield* io.out(`${plugin} is already switched on. Nothing changed.`);
      return;
    }
    const { current } = record;
    const digest = yield* Effect.result(filesDigest(current.folder));
    if (digest._tag === "Failure") {
      yield* io.err(`Plugin files: ${digest.failure.reason}.`);
      return yield* failed;
    }
    if (digest.success !== current.filesDigest) {
      yield* io.err(
        current.source === "folder"
          ? `The files in ${current.folder} changed since they were approved. Review them and run: aphelion plugin install ${current.folder}`
          : `The files in ${current.folder} changed since they were approved, so ${plugin} stays off.`,
      );
      return yield* failed;
    }
    const token = enableToken(current);
    if (approve === undefined) {
      yield* io.out(
        `Plugin ${plugin} ${current.version} at ${JSON.stringify(current.folder)} is switched off.`,
      );
      for (const { kind, name } of current.grants) {
        yield* io.out(`${kind}\t${JSON.stringify(name)}`);
      }
      if (current.grants.length === 0) {
        yield* io.out("No permissions requested.");
      }
      yield* io.out(
        `These are the permissions it already has. To switch it on, repeat the command with --approve ${token}`,
      );
      return;
    }
    const saved =
      approve === token &&
      (yield* switchOn(stateDir, record, token).pipe(
        Effect.catch((error) =>
          error instanceof UpdateRefused
            ? Effect.andThen(io.err(error.reason), Effect.fail(failed))
            : Effect.fail(error),
        ),
      ));
    if (!saved) {
      yield* io.err(
        "The approval does not match this plugin's files or permissions. Preview the plugin again.",
      );
      return yield* failed;
    }
    const outcome = yield* restartPlugin(stateDir, plugin);
    switch (outcome.kind) {
      case "server not running":
        return yield* io.out(
          `Switched on ${plugin}. The server isn't running, so ${plugin} starts when the server starts.`,
        );
      case "refused":
        yield* io.err(
          `Switched on ${plugin}, but the server didn't restart it: ${outcome.reason.replace(/\.$/, "")}.`,
        );
        return yield* failed;
      case "restarted":
        if (outcome.state === "running") {
          return yield* io.out(`Switched on ${plugin}. It runs.`);
        }
        yield* io.err(
          `Switched on ${plugin}, but it isn't running: ${outcome.state}. The server log says why.`,
        );
        return yield* failed;
    }
  });

export const pluginEnableCommand = (
  handler: Handler<Parameters<typeof pluginEnable>[0]>,
) =>
  Command.make(
    "enable",
    {
      stateDir: stateDirFlag,
      plugin: operandArgument(operands["plugin enable"]),
      approve: approveFlag,
    },
    handler,
  ).pipe(
    Command.withDescription(
      "Switch a plugin on after a restore. Preview what it is allowed to do, then repeat with the displayed digest.",
    ),
  );
