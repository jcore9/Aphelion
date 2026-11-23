import { Effect } from "effect";
import { restartPlugin } from "../plugins/control-client";
import type { Permission } from "../plugins/grants";
import { withFilesLock } from "../plugins/updates/files-lock";
import { githubClient } from "../plugins/updates/github";
import { UpdateRefused } from "../plugins/updates/refused";
import {
  applyUpdate,
  prepareUpdate,
  rollback,
  type SwitchOutcome,
  type Updates,
} from "../plugins/updates/updater";
import { withStore } from "./device";
import { failed } from "./failure";
import { CliIo } from "./io";

interface Target {
  readonly stateDir: string;
  readonly pluginsDir: string;
  readonly plugin: string;
}

const withUpdates = <A, R>(
  target: Target,
  githubApi: string | undefined,
  use: (updates: Updates) => Effect.Effect<A, Error, R>,
) =>
  Effect.gen(function* () {
    const github = yield* Effect.try({
      try: () => githubClient({ api: githubApi }),
      catch: (error) => error as UpdateRefused,
    });
    return yield* withFilesLock(
      target.stateDir,
      withStore(target.stateDir, (db) =>
        use({
          db,
          pluginsDir: target.pluginsDir,
          github,
          restart: (plugin) => restartPlugin(target.stateDir, plugin),
        }),
      ),
    );
  }).pipe(
    Effect.catch((error) =>
      error instanceof UpdateRefused
        ? Effect.gen(function* () {
            yield* (yield* CliIo).err(error.reason);
            return yield* failed;
          })
        : Effect.fail(error),
    ),
  );

const permissionLine = (verb: string, { kind, name }: Permission) =>
  `${verb}\t${kind}\t${JSON.stringify(name)}`;

const afterSwitch = (
  outcome: SwitchOutcome,
  plugin: string,
  version: string,
) => {
  switch (outcome.kind) {
    case "running":
      return `${plugin} ${version} runs.`;
    case "client only":
      return `${plugin} has no server part to restart.`;
    case "server not running":
      return `The server isn't running, so ${plugin} starts on ${version} when the server starts.`;
    case "not running":
      return `${plugin} ${version} doesn't run: ${outcome.detail}.`;
  }
};

export const pluginUpdate = (
  options: Target & { readonly approve: string | undefined },
  githubApi: string | undefined,
) =>
  withUpdates(options, githubApi, (updates) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      const { plugin, approve } = options;
      const prepared = yield* prepareUpdate(updates, plugin);
      if (prepared.kind === "up to date") {
        yield* io.out(
          `${plugin} is already on ${prepared.version}, the latest release.`,
        );
        return;
      }
      const { plan } = prepared;
      const { from, next } = plan;
      if (approve === undefined) {
        yield* io.out(
          `Plugin ${plugin} can update from ${from.version} to ${next.version}.`,
        );
        yield* io.out(
          `GitHub attests that ${next.repository ?? ""}'s release workflow built ${next.version} from tag v${next.version}.`,
        );
        for (const grant of plan.added) {
          yield* io.out(permissionLine("adds", grant));
        }
        for (const grant of plan.removed) {
          yield* io.out(permissionLine("drops", grant));
        }
        if (plan.added.length + plan.removed.length === 0) {
          yield* io.out("No permission changes.");
        }
        yield* io.out(
          `Review the changes above. To install ${next.version} and grant its permissions, repeat the command with --approve ${plan.token}`,
        );
        return;
      }
      const applied = yield* applyUpdate(updates, plan, approve);
      if (applied.kind === "switched") {
        yield* io.out(
          `Updated ${plugin} from ${from.version} to ${next.version}.`,
        );
        yield* io.out(afterSwitch(applied.outcome, plugin, next.version));
        return;
      }
      yield* io.err(
        `${plugin} ${next.version} didn't start (${applied.failed}), so Aphelion went back to ${from.version}.`,
      );
      yield* io.err(afterSwitch(applied.outcome, plugin, from.version));
      return yield* failed;
    }).pipe(Effect.scoped),
  );

export const pluginRollback = (options: Target) =>
  withUpdates(options, undefined, (updates) =>
    Effect.gen(function* () {
      const io = yield* CliIo;
      const back = yield* rollback(updates, options.plugin);
      const line = afterSwitch(back.outcome, options.plugin, back.to);
      yield* io.out(
        `Went back from ${options.plugin} ${back.from} to ${back.to}.`,
      );
      if (back.outcome.kind === "not running") {
        yield* io.err(line);
        return yield* failed;
      }
      yield* io.out(line);
    }),
  );
