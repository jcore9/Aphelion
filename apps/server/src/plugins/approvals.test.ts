import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openStore } from "../store";
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
    current: release,
    previous: version("1.0.0"),
  });

  const again = { ...release, filesDigest: "digest-again" };
  recordVersion(db, again);
  expect(installedPlugins(db)).toEqual([
    { plugin: "weather", current: again, previous: version("1.0.0") },
  ]);

  recordVersion(db, version("1.0.0"));
  expect(readInstall(db, "weather")).toEqual({
    plugin: "weather",
    current: version("1.0.0"),
    previous: again,
  });
});

test("only the dev folder's approval skips the files check", () => {
  const record = {
    plugin: "weather",
    current: version("1.0.0"),
    previous: undefined,
  };
  expect(approvalFor(record, undefined)).toEqual({
    id: "weather",
    version: "1.0.0",
    filesDigest: "digest-1.0.0",
  });
  expect(approvalFor(record, "/opt/aphelion/dev-plugin")).toEqual({
    id: "weather",
    version: "1.0.0",
    filesDigest: "digest-1.0.0",
  });
  expect(approvalFor(record, "/opt/aphelion/plugins/weather-1.0.0")).toEqual({
    id: "weather",
    version: "1.0.0",
    filesDigest: undefined,
  });
});
