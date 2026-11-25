import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { expect, onTestFinished, test } from "vitest";
import { openStore } from "../../store";
import type { Database } from "../../store/database";
import { readInstall, recordVersion } from "../approvals";
import type { RestartOutcome } from "../control-client";
import { noServerPart } from "../control";
import { filesDigest } from "../tree-digest";
import type { GithubClient } from "./github";
import { UpdateRefused } from "./refused";
import { readTar, writeEntries } from "./tar";
import { applyUpdate, prepareUpdate, rollback, type Updates } from "./updater";

const plugin = "aphelion-test-plugin";
const repository = "jcore9-bot/aphelion-test-plugin";
const fixture = (version: string, file: string) =>
  readFileSync(
    join(import.meta.dirname, "fixtures", plugin, `v${version}`, file),
  );

interface Setup {
  readonly db: Database;
  readonly root: string;
  readonly pluginsDir: string;
  readonly restarts: string[];
  readonly updates: (options?: {
    readonly latest?: string;
    readonly archive?: Uint8Array;
    readonly outcomes?: RestartOutcome[];
  }) => Updates;
}

async function setup(): Promise<Setup> {
  const root = await mkdtemp(join(tmpdir(), "aphelion-updates-"));
  const pluginsDir = join(root, "plugins");
  await mkdir(pluginsDir);
  const db = openStore(join(root, "aphelion.db"));
  onTestFinished(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const restarts: string[] = [];
  return {
    db,
    root,
    pluginsDir,
    restarts,
    updates: (options = {}) => {
      const latest = options.latest ?? "1.1.0";
      const outcomes = [...(options.outcomes ?? [])];
      const github: GithubClient = {
        latestRelease: () =>
          Promise.resolve({
            version: latest,
            archiveUrl: "archive",
            bundleUrl: "bundle",
          }),
        download: (url) =>
          Promise.resolve(
            url === "archive"
              ? (options.archive ?? fixture(latest, "aphelion-plugin.tar"))
              : fixture(latest, "aphelion-plugin.tar.sigstore.json"),
          ),
      };
      return {
        db,
        pluginsDir,
        github,
        restart: (id) =>
          Effect.sync(() => {
            restarts.push(
              `${id} ${readInstall(db, id)?.current.version ?? ""}`,
            );
            return outcomes.shift() ?? { kind: "restarted", state: "running" };
          }),
      };
    },
  };
}

async function installFolder(
  { db, root }: Setup,
  version: string,
  folder = join(root, `folder-${version}`),
) {
  const unpacked = readTar(fixture("1.0.0", "aphelion-plugin.tar"));
  if (!unpacked.ok) throw new Error(unpacked.reason);
  await mkdir(folder);
  await writeEntries(unpacked.entries, folder);
  recordVersion(db, {
    plugin,
    version,
    source: "folder",
    folder,
    filesDigest: await Effect.runPromise(filesDigest(folder)),
    repository,
    grants: [{ kind: "events", name: "approval.requested" }],
  });
  return folder;
}

const preview = (updates: Updates) =>
  Effect.runPromise(prepareUpdate(updates, plugin).pipe(Effect.scoped));

const update = (updates: Updates, token?: string) =>
  Effect.runPromiseExit(
    prepareUpdate(updates, plugin).pipe(
      Effect.flatMap((prepared): Effect.Effect<unknown, Error> =>
        prepared.kind === "up to date"
          ? Effect.succeed(prepared)
          : applyUpdate(updates, prepared.plan, token ?? prepared.plan.token),
      ),
      Effect.scoped,
    ),
  );

const refusalOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined;
  const error = exit.cause.reasons[0];
  return error?._tag === "Fail" && error.error instanceof UpdateRefused
    ? error.error.reason
    : String(exit.cause);
};

const versions = (db: Database) =>
  db
    .all("SELECT version, source FROM plugin_versions ORDER BY version")
    .map((row) => `${String(row["version"])} ${String(row["source"])}`);

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("a preview shows the permission changes and leaves no files or records", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  const prepared = await preview(context.updates());
  expect(prepared.kind).toBe("update");
  if (prepared.kind !== "update") return;
  const { plan } = prepared;
  expect(plan.from.version).toBe("1.0.0");
  expect(plan.next).toMatchObject({
    version: "1.1.0",
    source: "release",
    folder: join(context.pluginsDir, `${plugin}@1.1.0`),
    repository,
  });
  expect(plan.added).toEqual([{ kind: "events", name: "bot.status" }]);
  expect(plan.removed).toEqual([]);
  expect(plan.token).toMatch(/^[0-9a-f]{64}$/);
  expect(await readdir(join(context.pluginsDir, ".staging"))).toEqual([]);
  expect(await exists(plan.next.folder)).toBe(false);
  expect(versions(context.db)).toEqual(["1.0.0 folder"]);
  expect(context.restarts).toEqual([]);
});

test("an approved update installs the release and restarts the plugin on it", async () => {
  const context = await setup();
  const folder = await installFolder(context, "1.0.0");
  const exit = await update(context.updates());
  expect(exit).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
  const record = readInstall(context.db, plugin);
  expect(record?.current).toMatchObject({
    version: "1.1.0",
    source: "release",
    grants: [
      { kind: "events", name: "approval.requested" },
      { kind: "events", name: "bot.status" },
    ],
  });
  expect(record?.previous?.folder).toBe(folder);
  const installed = join(context.pluginsDir, `${plugin}@1.1.0`);
  expect((await stat(installed)).mode & 0o777).toBe(0o755);
  expect(await Effect.runPromise(filesDigest(installed))).toBe(
    record?.current.filesDigest,
  );
  expect(context.restarts).toEqual([`${plugin} 1.1.0`]);

  expect(await preview(context.updates())).toEqual({
    kind: "up to date",
    version: "1.1.0",
  });
});

test("a wrong token changes nothing", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  expect(refusalOf(await update(context.updates(), "0".repeat(64)))).toBe(
    "The approval doesn't match this release's files, permissions or the installed version. Preview the update again.",
  );
  expect(versions(context.db)).toEqual(["1.0.0 folder"]);
  expect(await readdir(context.pluginsDir)).toEqual([".staging"]);
  expect(await readdir(join(context.pluginsDir, ".staging"))).toEqual([]);
});

test("an archive with one changed byte is refused before it is unpacked", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  const archive = Buffer.from(fixture("1.1.0", "aphelion-plugin.tar"));
  archive[600] = (archive[600] ?? 0) ^ 1;
  expect(refusalOf(await update(context.updates({ archive })))).toBe(
    "The release's attestation vouches for other bytes than the downloaded aphelion-plugin.tar, so Aphelion won't install it.",
  );
  expect(versions(context.db)).toEqual(["1.0.0 folder"]);
  expect(context.restarts).toEqual([]);
});

test("a release older than the installed version is refused", async () => {
  const context = await setup();
  await installFolder(context, "1.0.5");
  expect(refusalOf(await update(context.updates({ latest: "1.0.0" })))).toBe(
    `The latest release of ${repository} is 1.0.0, older than the installed 1.0.5. Only aphelion plugin rollback goes back.`,
  );
});

test("a release for another plugin id is refused", async () => {
  const context = await setup();
  const folder = join(context.root, "other-plugin");
  await mkdir(folder);
  recordVersion(context.db, {
    plugin: "other-plugin",
    version: "1.0.0",
    source: "folder",
    folder,
    filesDigest: "digest",
    repository,
    grants: [],
  });
  const updates = context.updates();
  const exit = await Effect.runPromiseExit(
    prepareUpdate(updates, "other-plugin").pipe(Effect.scoped),
  );
  expect(refusalOf(exit)).toBe(
    `The release holds the plugin ${plugin}, not other-plugin.`,
  );
});

test("a plugin without a repository can't update", async () => {
  const context = await setup();
  recordVersion(context.db, {
    plugin,
    version: "1.0.0",
    source: "folder",
    folder: context.root,
    filesDigest: "digest",
    repository: undefined,
    grants: [],
  });
  expect(refusalOf(await update(context.updates()))).toBe(
    `${plugin} 1.0.0 names no GitHub repository in its manifest, so it can't update from releases.`,
  );
});

test("a version that doesn't reach running is rolled back at once", async () => {
  const context = await setup();
  await installFolder(context, "0.9.0");
  await installFolder(context, "1.0.0");
  const exit = await update(
    context.updates({
      outcomes: [{ kind: "restarted", state: "crashed" }],
    }),
  );
  expect(exit).toEqual(
    Exit.succeed({
      kind: "rolled back",
      failed: "it is crashed",
      outcome: { kind: "running" },
    }),
  );
  expect(context.restarts).toEqual([`${plugin} 1.1.0`, `${plugin} 1.0.0`]);
  const record = readInstall(context.db, plugin);
  expect([record?.current.version, record?.previous?.version]).toEqual([
    "1.0.0",
    "0.9.0",
  ]);
  expect(versions(context.db)).toEqual(["0.9.0 folder", "1.0.0 folder"]);
  expect(await exists(join(context.pluginsDir, `${plugin}@1.1.0`))).toBe(false);
});

test("an update keeps both releases when restarting either version fails", async () => {
  const context = await setup();
  await installFolder(context, "0.9.0");
  expect(await update(context.updates({ latest: "1.0.0" }))).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
  const exit = await update(
    context.updates({
      outcomes: [
        { kind: "restarted", state: "crashed" },
        { kind: "restarted", state: "stopped" },
      ],
    }),
  );
  expect(exit).toEqual(
    Exit.succeed({
      kind: "rolled back",
      failed: "it is crashed",
      outcome: { kind: "not running", detail: "it is stopped" },
    }),
  );
  expect(readInstall(context.db, plugin)).toMatchObject({
    current: { version: "1.0.0" },
    previous: { version: "0.9.0" },
  });
  expect(versions(context.db)).toEqual([
    "0.9.0 folder",
    "1.0.0 release",
    "1.1.0 release",
  ]);
  expect((await readdir(context.pluginsDir)).sort()).toEqual([
    ".staging",
    `${plugin}@1.0.0`,
    `${plugin}@1.1.0`,
  ]);
});

test("a client-only plugin and a stopped server keep the new version", async () => {
  for (const outcome of [
    { kind: "refused", reason: noServerPart(plugin) },
    { kind: "server not running" },
  ] as const) {
    const context = await setup();
    await installFolder(context, "1.0.0");
    const exit = await update(context.updates({ outcomes: [outcome] }));
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      kind: "switched",
    });
    expect(readInstall(context.db, plugin)?.current.version).toBe("1.1.0");
  }
});

test("an update drops the version before previous, but never a folder install's files", async () => {
  const context = await setup();
  const oldest = await installFolder(context, "0.9.0");
  await installFolder(context, "1.0.0");
  await update(context.updates());
  expect(versions(context.db)).toEqual(["1.0.0 folder", "1.1.0 release"]);
  expect(await exists(oldest)).toBe(true);
});

test("rollback goes back one version and deletes the release it left", async () => {
  const context = await setup();
  const folder = await installFolder(context, "1.0.0");
  await update(context.updates());
  const back = await Effect.runPromise(rollback(context.updates(), plugin));
  expect(back).toEqual({
    kind: "switched",
    from: "1.1.0",
    to: "1.0.0",
    outcome: { kind: "running" },
  });
  expect(readInstall(context.db, plugin)).toMatchObject({
    current: { version: "1.0.0", folder },
    previous: undefined,
  });
  expect(versions(context.db)).toEqual(["1.0.0 folder"]);
  expect(await exists(join(context.pluginsDir, `${plugin}@1.1.0`))).toBe(false);
  expect(context.restarts).toEqual([`${plugin} 1.1.0`, `${plugin} 1.0.0`]);

  const again = await Effect.runPromiseExit(
    rollback(context.updates(), plugin),
  );
  expect(refusalOf(again)).toBe(
    `${plugin} has no earlier version to go back to.`,
  );
});

test("a release never lands inside a folder install named after the plugin", async () => {
  const context = await setup();
  const folder = await installFolder(
    context,
    "1.0.0",
    join(context.pluginsDir, plugin),
  );
  const digest = readInstall(context.db, plugin)?.current.filesDigest;
  await update(context.updates());
  expect(await Effect.runPromise(filesDigest(folder))).toBe(digest);
  expect(readInstall(context.db, plugin)?.previous?.filesDigest).toBe(digest);
});

test("rolling back from a folder install keeps its files", async () => {
  const context = await setup();
  await installFolder(context, "0.9.0");
  const newer = await installFolder(context, "1.0.0");
  await Effect.runPromise(rollback(context.updates(), plugin));
  expect(versions(context.db)).toEqual(["0.9.0 folder"]);
  expect(await exists(newer)).toBe(true);
});

test("an approval stops working when the installed approval changes, even at the same version", async () => {
  const context = await setup();
  const folder = await installFolder(context, "1.0.0");
  const updates = context.updates();
  const changed = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const prepared = yield* prepareUpdate(updates, plugin);
      if (prepared.kind !== "update") return yield* Effect.die("no update");
      const current = readInstall(context.db, plugin)?.current;
      if (current === undefined) return yield* Effect.die("not installed");
      recordVersion(context.db, { ...current, grants: [] });
      return yield* applyUpdate(updates, prepared.plan, prepared.plan.token);
    }).pipe(Effect.scoped),
  );
  expect(refusalOf(changed)).toBe(
    `The installed ${plugin} changed since the preview. Preview the update again.`,
  );
  expect(versions(context.db)).toEqual(["1.0.0 folder"]);
  expect(readInstall(context.db, plugin)?.current).toMatchObject({
    folder,
    grants: [],
  });
  expect(await update(context.updates())).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
});

test("a rollback whose version doesn't start returns to the version it left and deletes nothing", async () => {
  const context = await setup();
  const folder = await installFolder(context, "1.0.0");
  await update(context.updates());
  const release = join(context.pluginsDir, `${plugin}@1.1.0`);
  const back = await Effect.runPromise(
    rollback(
      context.updates({
        outcomes: [
          {
            kind: "refused",
            reason: `${plugin} stays stopped: the plugin's files changed since they were approved.`,
          },
        ],
      }),
      plugin,
    ),
  );
  expect(back).toEqual({
    kind: "restored",
    from: "1.1.0",
    to: "1.0.0",
    failed: `${plugin} stays stopped: the plugin's files changed since they were approved.`,
    outcome: { kind: "running" },
  });
  expect(readInstall(context.db, plugin)).toMatchObject({
    current: { version: "1.1.0", folder: release },
    previous: { version: "1.0.0", folder },
  });
  expect(await exists(release)).toBe(true);
  expect(versions(context.db)).toEqual(["1.0.0 folder", "1.1.0 release"]);
  expect(context.restarts).toEqual([
    `${plugin} 1.1.0`,
    `${plugin} 1.0.0`,
    `${plugin} 1.1.0`,
  ]);
});

test("a release folder that another approved version names is never deleted", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  await update(context.updates());
  const release = join(context.pluginsDir, `${plugin}@1.1.0`);
  const approved = readInstall(context.db, plugin)?.current;
  if (approved === undefined) throw new Error("not installed");
  recordVersion(context.db, {
    ...approved,
    version: "1.2.0",
    source: "folder",
  });
  await installFolder(context, "1.3.0");
  await Effect.runPromise(rollback(context.updates(), plugin));
  expect(versions(context.db)).toEqual(["1.2.0 folder"]);
  expect(await exists(release)).toBe(true);
});

test("a rollback deletes the release it left under any spelling of the plugins folder", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  await update(context.updates());
  const link = join(context.root, "plugins-link");
  await symlink(context.pluginsDir, link);
  const back = await Effect.runPromise(
    rollback({ ...context.updates(), pluginsDir: link }, plugin),
  );
  expect(back.kind).toBe("switched");
  expect(await exists(join(context.pluginsDir, `${plugin}@1.1.0`))).toBe(false);
  expect(await update(context.updates())).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
});

test("an update and a rollback clear a release folder that no approval names, and keep one that an approval names", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  const release = join(context.pluginsDir, `${plugin}@1.1.0`);
  const leftover = join(context.pluginsDir, `${plugin}@0.5.0`);
  await mkdir(release);
  await writeFile(join(release, "half-moved"), "");
  recordVersion(context.db, {
    plugin: "other-plugin",
    version: "1.0.0",
    source: "folder",
    folder: release,
    filesDigest: "digest",
    repository: undefined,
    grants: [],
  });
  expect(refusalOf(await update(context.updates()))).toBe(
    `${release} already exists. Move it away, then update again.`,
  );
  expect(await exists(release)).toBe(true);

  context.db.run("DELETE FROM plugin_installs WHERE plugin = ?", [
    "other-plugin",
  ]);
  context.db.run("DELETE FROM plugin_versions WHERE plugin = ?", [
    "other-plugin",
  ]);
  expect(await update(context.updates())).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
  expect(await exists(join(release, "half-moved"))).toBe(false);

  await mkdir(leftover);
  await Effect.runPromise(rollback(context.updates(), plugin));
  expect(await exists(leftover)).toBe(false);
});

test("cleanup keeps approved descendants through aliases and removes only unapproved managed files", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  const dir = context.pluginsDir;
  const release = join(dir, `${plugin}@1.1.0`);
  const orphan = join(dir, `${plugin}@0.5.0`);
  const ordinary = join(dir, `${plugin}@notes`);
  const staging = join(dir, ".staging");
  await mkdir(staging, { mode: 0o755 });
  const staleStage = join(staging, "release-stale");
  const approvedStage = join(staging, "release-kept", "nested");
  for (const path of [orphan, ordinary, staleStage, approvedStage]) {
    await mkdir(path, { recursive: true });
  }
  const alias = join(context.root, "plugins-alias");
  await symlink(dir, alias);
  const approve = (id: string, folder: string) => {
    recordVersion(context.db, {
      plugin: id,
      version: "1.0.0",
      source: "folder",
      folder,
      filesDigest: "digest",
      repository: undefined,
      grants: [],
    });
  };
  approve("staged", join(alias, ".staging", "release-kept", "nested"));
  expect(await update(context.updates())).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
  expect(await exists(orphan)).toBe(false);
  expect(await exists(staleStage)).toBe(false);
  expect(await exists(ordinary)).toBe(true);
  expect(await exists(approvedStage)).toBe(true);

  const nested = join(release, "nested");
  await mkdir(nested);
  await writeFile(join(nested, "keep.txt"), "approved");
  approve("nested", join(alias, `${plugin}@1.1.0`, "nested"));
  expect(
    (await Effect.runPromise(rollback(context.updates(), plugin))).kind,
  ).toBe("switched");
  expect(await exists(join(nested, "keep.txt"))).toBe(true);
  expect(await exists(approvedStage)).toBe(true);

  const prepared = await preview(context.updates()).catch(
    (error: unknown) => error,
  );
  expect(prepared).toMatchObject({
    reason: `${release} already exists. Move it away, then update again.`,
  });
  expect(await exists(join(nested, "keep.txt"))).toBe(true);
});

test("sweep keeps directory entries crossed by an approved link chain", async () => {
  const context = await setup();
  await installFolder(context, "1.0.0");
  const release = join(context.pluginsDir, "bridge@1.0.0");
  const waypoint = join(context.pluginsDir, "waypoint@1.0.0");
  const orphan = join(context.pluginsDir, "orphan@1.0.0");
  const staging = join(context.pluginsDir, ".staging");
  const staleStage = join(staging, "release-stale");
  const stage = join(staging, "release-bridge");
  const target = join(context.root, "target");
  for (const folder of [release, waypoint, orphan, staleStage, stage, target]) {
    await mkdir(folder, { recursive: true });
  }
  await writeFile(join(target, "keep.txt"), "approved");
  await symlink("../../../target", join(stage, "target"));
  await symlink("../.staging/release-bridge", join(release, "stage"));
  const alias = join(context.root, "alias");
  await symlink("plugins/waypoint@1.0.0/../bridge@1.0.0/stage", alias);
  recordVersion(context.db, {
    plugin: "linked-folder",
    version: "1.0.0",
    source: "folder",
    folder: join(alias, "target"),
    filesDigest: "digest",
    repository: undefined,
    grants: [],
  });

  expect(await preview(context.updates({ latest: "1.0.0" }))).toEqual({
    kind: "up to date",
    version: "1.0.0",
  });
  expect(await readFile(join(alias, "target", "keep.txt"), "utf8")).toBe(
    "approved",
  );
  expect(await exists(orphan)).toBe(false);
  expect(await exists(staleStage)).toBe(false);
});

test("prune keeps an old release directory crossed by another approval", async () => {
  const context = await setup();
  const folder = await installFolder(context, "1.0.0");
  expect(await update(context.updates())).toEqual(
    Exit.succeed({ kind: "switched", outcome: { kind: "running" } }),
  );
  const release = join(context.pluginsDir, `${plugin}@1.1.0`);
  const alias = join(context.root, "alias");
  await writeFile(join(folder, "keep.txt"), "approved");
  await symlink(folder, join(release, "target"));
  await symlink(join(release, "target"), alias);
  recordVersion(context.db, {
    plugin: "linked-folder",
    version: "1.0.0",
    source: "folder",
    folder: alias,
    filesDigest: "digest",
    repository: undefined,
    grants: [],
  });

  expect(
    await Effect.runPromise(rollback(context.updates(), plugin)),
  ).toMatchObject({
    kind: "switched",
    to: "1.0.0",
  });
  expect(versions(context.db)).toEqual(["1.0.0 folder", "1.0.0 folder"]);
  expect(await readFile(join(alias, "keep.txt"), "utf8")).toBe("approved");
});
