import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { expect, onTestFinished, test } from "vitest";
import { openStore } from "../store";
import { PluginGrants, sqlitePluginGrants } from "./grants";
import {
  approvalFor,
  installedPlugins,
  readInstall,
  recordVersion,
  type ApprovedVersion,
} from "./approvals";

async function store() {
  const dir = await mkdtemp(join(tmpdir(), "aphelion-approvals-"));
  const db = openStore(join(dir, "aphelion.db"));
  onTestFinished(async () => {
    db.close();
    await rm(dir, { recursive: true });
  });
  return db;
}

const version = (
  number: string,
  overrides: Partial<ApprovedVersion> = {},
): ApprovedVersion => ({
  plugin: "weather",
  version: number,
  source: "folder",
  folder: `/opt/aphelion/plugins/weather-${number}`,
  filesDigest: `digest-${number}`,
  repository: undefined,
  grants: [{ kind: "events", name: "bot.status" }],
  ...overrides,
});

test("recording a version keeps the one it replaces as previous", async () => {
  const db = await store();
  expect(readInstall(db, "weather")).toBeUndefined();

  recordVersion(db, version("1.0.0"));
  expect(readInstall(db, "weather")).toEqual({
    plugin: "weather",
    enabled: true,
    current: version("1.0.0"),
    previous: undefined,
  });

  const release = version("1.1.0", {
    source: "release",
    repository: "jcore9-bot/aphelion-test-plugin",
    grants: [],
  });
  recordVersion(db, release);
  expect(readInstall(db, "weather")).toEqual({
    plugin: "weather",
    enabled: true,
    current: release,
    previous: version("1.0.0"),
  });

  const again = { ...release, filesDigest: "digest-again" };
  recordVersion(db, again);
  expect(installedPlugins(db)).toEqual([
    {
      plugin: "weather",
      enabled: true,
      current: again,
      previous: version("1.0.0"),
    },
  ]);

  recordVersion(db, version("1.0.0"));
  expect(readInstall(db, "weather")).toEqual({
    plugin: "weather",
    enabled: true,
    current: version("1.0.0"),
    previous: again,
  });
});

test("only the dev folder's approval skips the files check", () => {
  const record = {
    plugin: "weather",
    enabled: true,
    current: version("1.0.0"),
    previous: undefined,
  };
  const folder = "/opt/aphelion/plugins/weather-1.0.0";
  expect(approvalFor(record, undefined)).toEqual({
    id: "weather",
    version: "1.0.0",
    folder,
    filesDigest: "digest-1.0.0",
  });
  expect(approvalFor(record, "/opt/aphelion/dev-plugin")).toEqual({
    id: "weather",
    version: "1.0.0",
    folder,
    filesDigest: "digest-1.0.0",
  });
  expect(approvalFor(record, folder)).toEqual({
    id: "weather",
    version: "1.0.0",
    folder,
    filesDigest: undefined,
  });
});

test("a run keeps its grants only while its exact approval stands", async () => {
  const db = await store();
  const grants = Effect.runSync(
    Layer.build(sqlitePluginGrants(db)).pipe(
      Effect.map((services) => Context.get(services, PluginGrants)),
      Effect.scoped,
    ),
  );
  const status = { kind: "events", name: "bot.status" } as const;
  const allowed = (approval: Parameters<typeof grants.allows>[0]) =>
    Effect.runSync(grants.allows(approval, status));
  recordVersion(db, version("1.0.0"));
  const first = approvalFor(
    { plugin: "weather", current: version("1.0.0") },
    undefined,
  );
  const dev = { ...first, filesDigest: undefined };
  expect(allowed(first)).toBe(true);
  expect(allowed(dev)).toBe(true);

  const sameFolder = version("1.0.0", { filesDigest: "digest-edited" });
  recordVersion(db, sameFolder);
  expect(allowed(first)).toBe(false);
  expect(allowed(dev)).toBe(true);
  expect(allowed({ ...first, filesDigest: "digest-edited" })).toBe(true);

  const elsewhere = version("1.0.0", { folder: "/srv/weather-copy" });
  recordVersion(db, elsewhere);
  expect(allowed(first)).toBe(false);
  expect(allowed(dev)).toBe(false);
  expect(
    allowed({ ...first, folder: elsewhere.folder, filesDigest: undefined }),
  ).toBe(true);
});

test("a switched-off plugin has no approval and no grant, and switching it on restores both", async () => {
  const db = await store();
  const grants = Effect.runSync(
    Layer.build(sqlitePluginGrants(db)).pipe(
      Effect.map((services) => Context.get(services, PluginGrants)),
      Effect.scoped,
    ),
  );
  recordVersion(db, version("1.0.0"));
  const approval = approvalFor(
    { plugin: "weather", current: version("1.0.0") },
    undefined,
  );
  const status = { kind: "events", name: "bot.status" } as const;
  const answers = () => [
    Effect.runSync(grants.hasApproval(approval)),
    Effect.runSync(grants.allows(approval, status)),
  ];
  expect(answers()).toEqual([true, true]);

  db.run("UPDATE plugin_installs SET enabled = 0 WHERE plugin = 'weather'");
  expect(answers()).toEqual([false, false]);

  recordVersion(db, version("1.0.0"));
  expect(answers()).toEqual([false, false]);

  db.run("UPDATE plugin_installs SET enabled = 1 WHERE plugin = 'weather'");
  expect(answers()).toEqual([true, true]);
});
