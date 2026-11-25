import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { Effect } from "effect";
import { gt } from "semver";
import type { Database } from "../../store/database";
import {
  readInstall,
  recordVersion,
  switchedOffMessage,
  updateToken,
  type ApprovedVersion,
  type InstallRecord,
} from "../approvals";
import type { RestartOutcome } from "../control-client";
import { noServerPart } from "../control";
import { permissionList, type Permission } from "../grants";
import { readManifest } from "../manifest-file";
import { filesDigest } from "../tree-digest";
import type { GithubClient } from "./github";
import { UpdateRefused } from "./refused";
import { isReleaseDirectoryName } from "./release-path";
import { readTar, writeEntries } from "./tar";
import { verifyRelease } from "./verify";

export interface Updates {
  readonly db: Database;
  readonly pluginsDir: string;
  readonly github: GithubClient;
  readonly restart: (plugin: string) => Effect.Effect<RestartOutcome, Error>;
}

export interface UpdatePlan {
  readonly from: ApprovedVersion;
  readonly next: ApprovedVersion;
  readonly added: readonly Permission[];
  readonly removed: readonly Permission[];
  readonly staging: string;
  readonly token: string;
}

export type Prepared =
  | { readonly kind: "up to date"; readonly version: string }
  | { readonly kind: "update"; readonly plan: UpdatePlan };

export type SwitchOutcome =
  | { readonly kind: "running" }
  | { readonly kind: "server not running" }
  | { readonly kind: "client only" }
  | { readonly kind: "not running"; readonly detail: string };

export type Applied =
  | { readonly kind: "switched"; readonly outcome: SwitchOutcome }
  | {
      readonly kind: "rolled back";
      readonly failed: string;
      readonly outcome: SwitchOutcome;
    };

export type RolledBack =
  | {
      readonly kind: "switched";
      readonly from: string;
      readonly to: string;
      readonly outcome: SwitchOutcome;
    }
  | {
      readonly kind: "restored";
      readonly from: string;
      readonly to: string;
      readonly failed: string;
      readonly outcome: SwitchOutcome;
    };

const refuse = (reason: string) => new UpdateRefused({ reason });

const asError = (error: unknown) =>
  error instanceof Error ? error : new Error(String(error));

const attempt = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: asError });

const attemptSync = <A>(work: () => A) =>
  Effect.try({ try: work, catch: asError });

const sameGrant = (a: Permission) => (b: Permission) =>
  a.kind === b.kind && a.name === b.name;

const missingFrom = (list: readonly Permission[]) => (grant: Permission) =>
  !list.some(sameGrant(grant));

const installed = (db: Database, plugin: string) => {
  const record = readInstall(db, plugin);
  if (record === undefined) throw refuse(`${plugin} isn't installed.`);
  if (!record.enabled) throw refuse(switchedOffMessage(plugin));
  return record;
};

const stagingRoot = (pluginsDir: string) => join(pluginsDir, ".staging");

const contains = (parent: string, path: string) => {
  const child = relative(parent, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const traceFolder = async (folder: string, entries: Set<string>) => {
  let current = isAbsolute(folder) ? sep : process.cwd();
  const parts = folder.split(sep).reverse();
  let links = 0;
  entries.add(current);

  while (parts.length > 0) {
    const part = parts.pop();
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }

    const entry = join(current, part);
    entries.add(entry);
    const stat = await lstat(entry).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (stat === undefined) return entry;
    if (stat.isDirectory()) {
      current = entry;
      continue;
    }
    if (!stat.isSymbolicLink() || ++links > 40) {
      throw refuse(
        `Can't resolve the approved plugin folder ${folder} for cleanup.`,
      );
    }
    const target = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await readlink(entry, { encoding: "buffer" }));
    if (isAbsolute(target)) current = sep;
    // Expand the target before consuming any remaining components, including "..".
    parts.push(...target.split(sep).reverse());
  }
  return current;
};

const approvedPaths = async (db: Database) => {
  const folders = new Set<string>();
  const entries = new Set<string>();
  for (const row of db.all("SELECT DISTINCT folder FROM plugin_versions")) {
    const folder = String(row["folder"]);
    folders.add(resolve(folder));
    folders.add(await traceFolder(folder, entries));
  }
  return { folders, entries };
};

const removeUnapproved = async (
  path: string,
  { folders, entries }: Awaited<ReturnType<typeof approvedPaths>>,
) => {
  for (const folder of folders) {
    if (contains(path, folder) || contains(folder, path)) return;
  }
  for (const entry of entries) {
    if (contains(path, entry)) return;
  }
  await rm(path, { recursive: true, force: true });
};

const sweep = ({ db, pluginsDir: given }: Updates) =>
  Effect.gen(function* () {
    const pluginsDir = yield* attempt(() => realpath(given)).pipe(
      Effect.mapError(() =>
        refuse(`The plugins folder ${given} can't be read.`),
      ),
    );
    yield* attempt(async () => {
      const approved = await approvedPaths(db);
      for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
        const path = join(pluginsDir, entry.name);
        if (entry.name === ".staging") {
          if (entry.isDirectory()) {
            for (const child of await readdir(path)) {
              await removeUnapproved(join(path, child), approved);
            }
          } else {
            await removeUnapproved(path, approved);
          }
        } else if (entry.isDirectory() && isReleaseDirectoryName(entry.name)) {
          await removeUnapproved(path, approved);
        }
      }
    });
    return pluginsDir;
  });

const stagingFolder = (db: Database, pluginsDir: string) =>
  Effect.acquireRelease(
    attempt(async () => {
      const root = stagingRoot(pluginsDir);
      const { folders } = await approvedPaths(db);
      for (const folder of folders) {
        if (contains(folder, root)) {
          throw refuse(
            `${root} is inside an approved plugin folder and can't be used for updates.`,
          );
        }
      }
      await mkdir(root, { mode: 0o700, recursive: true });
      const stat = await lstat(root);
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0) {
        throw refuse(
          `${root} must be a directory writable only by its owner for plugin updates.`,
        );
      }
      const folder = await mkdtemp(join(root, "release-"));
      await chmod(folder, 0o755);
      return folder;
    }),
    (folder) =>
      Effect.promise(async () =>
        removeUnapproved(folder, await approvedPaths(db)),
      ),
  );

const releaseFolder = (pluginsDir: string, plugin: string, version: string) =>
  join(pluginsDir, `${plugin}@${version}`);

const checkManifest = (
  folder: string,
  record: InstallRecord,
  version: string,
  repository: string,
) =>
  Effect.gen(function* () {
    const read = yield* Effect.result(readManifest(folder));
    if (read._tag === "Failure") {
      const issues = read.failure.issues.map((issue) => issue.message);
      return yield* refuse(
        `The release's aphelion-plugin.json is refused: ${issues.join(" ")}`,
      );
    }
    const { manifest } = read.success;
    if (manifest.id !== record.plugin) {
      return yield* refuse(
        `The release holds the plugin ${manifest.id}, not ${record.plugin}.`,
      );
    }
    if (manifest.version !== version) {
      return yield* refuse(
        `The release tagged v${version} holds version ${manifest.version}.`,
      );
    }
    if (manifest.repository?.toLowerCase() !== repository.toLowerCase()) {
      return yield* refuse(
        `The release names the repository ${manifest.repository ?? "none"}, not ${repository}.`,
      );
    }
    return manifest;
  });

export const prepareUpdate = (updates: Updates, plugin: string) =>
  Effect.gen(function* () {
    const { db, github } = updates;
    const pluginsDir = yield* sweep(updates);
    const record = yield* attemptSync(() => installed(db, plugin));
    const { current } = record;
    const repository = current.repository;
    if (repository === undefined) {
      return yield* refuse(
        `${plugin} ${current.version} names no GitHub repository in its manifest, so it can't update from releases.`,
      );
    }
    const release = yield* attempt(() => github.latestRelease(repository));
    if (release.version === current.version) {
      return { kind: "up to date", version: current.version } as const;
    }
    if (!gt(release.version, current.version)) {
      return yield* refuse(
        `The latest release of ${repository} is ${release.version}, older than the installed ${current.version}. Only aphelion plugin rollback goes back.`,
      );
    }
    if (record.previous?.version === release.version) {
      return yield* refuse(
        `${plugin}'s previous version is already ${release.version}. Run aphelion plugin rollback ${plugin} to go back to it.`,
      );
    }
    const folder = releaseFolder(pluginsDir, plugin, release.version);
    const taken = yield* attempt(() =>
      lstat(folder).then(
        () => true,
        () => false,
      ),
    );
    if (taken) {
      return yield* refuse(
        `${folder} already exists. Move it away, then update again.`,
      );
    }
    const archive = yield* attempt(() =>
      github.download(release.archiveUrl, "archive"),
    );
    const bundle = yield* attempt(() =>
      github.download(release.bundleUrl, "bundle"),
    );
    yield* attemptSync(() => {
      verifyRelease({ repository, version: release.version, archive, bundle });
    });
    const unpacked = readTar(archive);
    if (!unpacked.ok) {
      return yield* refuse(
        `The release's archive is refused: ${unpacked.reason}.`,
      );
    }
    const staging = yield* stagingFolder(db, pluginsDir);
    yield* attempt(() => writeEntries(unpacked.entries, staging));
    const manifest = yield* checkManifest(
      staging,
      record,
      release.version,
      repository,
    );
    const digest = yield* filesDigest(staging).pipe(
      Effect.mapError((error) =>
        refuse(`The release's files are refused: ${error.reason}.`),
      ),
    );
    const grants = permissionList(manifest);
    const next: ApprovedVersion = {
      plugin,
      version: release.version,
      source: "release",
      folder,
      filesDigest: digest,
      repository,
      grants,
    };
    const plan: UpdatePlan = {
      from: current,
      next,
      added: grants.filter(missingFrom(current.grants)),
      removed: current.grants.filter(missingFrom(grants)),
      staging,
      token: updateToken(current, next),
    };
    return { kind: "update", plan } as const;
  });

const switchOutcome = (updates: Updates, plugin: string) =>
  updates.restart(plugin).pipe(
    Effect.map((outcome): SwitchOutcome => {
      switch (outcome.kind) {
        case "server not running":
          return outcome;
        case "refused":
          return outcome.reason === noServerPart(plugin)
            ? { kind: "client only" }
            : { kind: "not running", detail: outcome.reason };
        case "restarted":
          return outcome.state === "running"
            ? { kind: "running" }
            : { kind: "not running", detail: `it is ${outcome.state}` };
      }
    }),
    Effect.catch((error) =>
      Effect.succeed<SwitchOutcome>({
        kind: "not running",
        detail: error.message,
      }),
    ),
  );

const pointTo = (
  db: Database,
  plugin: string,
  version: string,
  previous: string | undefined,
) => {
  db.run(
    "UPDATE plugin_installs SET version = ?, previous = ? WHERE plugin = ?",
    [version, previous ?? null, plugin],
  );
};

const prune = (updates: Updates, plugin: string) =>
  attempt(async () => {
    const { db } = updates;
    const folders = db.transaction(() => {
      const rows = db.all(
        `SELECT v.version, v.source, v.folder FROM plugin_versions v
         JOIN plugin_installs i ON i.plugin = v.plugin
         WHERE v.plugin = ? AND v.version <> i.version
           AND (i.previous IS NULL OR v.version <> i.previous)`,
        [plugin],
      );
      for (const row of rows) {
        const params = [plugin, String(row["version"])];
        db.run(
          "DELETE FROM plugin_grants WHERE plugin = ? AND version = ?",
          params,
        );
        db.run(
          "DELETE FROM plugin_versions WHERE plugin = ? AND version = ?",
          params,
        );
      }
      return rows
        .filter((row) => row["source"] === "release")
        .map((row) => resolve(String(row["folder"])));
    });
    const pluginsDir = await realpath(updates.pluginsDir);
    const approved = await approvedPaths(db);
    for (const folder of folders) {
      if (
        dirname(folder) === pluginsDir &&
        isReleaseDirectoryName(basename(folder))
      ) {
        await removeUnapproved(folder, approved);
      }
    }
  });

export const applyUpdate = (
  updates: Updates,
  plan: UpdatePlan,
  token: string,
) =>
  Effect.gen(function* () {
    const { db } = updates;
    const { from, next } = plan;
    const plugin = next.plugin;
    if (token !== plan.token) {
      return yield* refuse(
        "The approval doesn't match this release's files, permissions or the installed version. Preview the update again.",
      );
    }
    yield* attempt(() => rename(plan.staging, next.folder));
    const previous = yield* attemptSync(() =>
      db.transaction(() => {
        const record = installed(db, plugin);
        if (updateToken(record.current, next) !== token) {
          throw refuse(
            `The installed ${plugin} changed since the preview. Preview the update again.`,
          );
        }
        recordVersion(db, next);
        return record.previous?.version;
      }),
    ).pipe(
      Effect.tapError(() =>
        Effect.promise(async () =>
          removeUnapproved(next.folder, await approvedPaths(db)),
        ),
      ),
    );
    const outcome = yield* switchOutcome(updates, plugin);
    if (outcome.kind !== "not running") {
      yield* prune(updates, plugin);
      return { kind: "switched", outcome } as const;
    }
    yield* attemptSync(() => {
      pointTo(db, plugin, from.version, previous);
    });
    const restored = yield* switchOutcome(updates, plugin);
    if (restored.kind !== "not running") yield* prune(updates, plugin);
    return {
      kind: "rolled back",
      failed: outcome.detail,
      outcome: restored,
    } as const;
  });

export const rollback = (updates: Updates, plugin: string) =>
  Effect.gen(function* () {
    const { db } = updates;
    yield* sweep(updates);
    const { from, to } = yield* attemptSync(() =>
      db.transaction(() => {
        const record = installed(db, plugin);
        if (record.previous === undefined) {
          throw refuse(`${plugin} has no earlier version to go back to.`);
        }
        pointTo(db, plugin, record.previous.version, undefined);
        return {
          from: record.current.version,
          to: record.previous.version,
        };
      }),
    );
    const outcome = yield* switchOutcome(updates, plugin);
    if (outcome.kind !== "not running") {
      yield* prune(updates, plugin);
      return { kind: "switched", from, to, outcome } satisfies RolledBack;
    }
    yield* attemptSync(() => {
      pointTo(db, plugin, from, to);
    });
    const restored = yield* switchOutcome(updates, plugin);
    return {
      kind: "restored",
      from,
      to,
      failed: outcome.detail,
      outcome: restored,
    } satisfies RolledBack;
  });
