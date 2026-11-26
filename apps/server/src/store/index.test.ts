import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { openStore } from ".";
import { openSqlite } from "../adapters/sqlite";
import { migrate } from "./migrate";
import { migrations } from "./migrations";

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aphelion-store-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true });
  });
  return join(dir, "aphelion.db");
}

test("applies the shipped migrations to a fresh database, then reopens it", () => {
  const path = tempDatabasePath();

  openStore(path).close();
  const store = openStore(path);

  expect(store.all("SELECT version, name FROM schema_migrations")).toEqual(
    migrations.map(({ version, name }) => ({ version, name })),
  );
  store.close();
});

test("migration 3 renames audit_log.agent_id to bot_id and keeps the rows", () => {
  const path = tempDatabasePath();
  const old = openSqlite(path);
  migrate(old, migrations.slice(0, 2));
  old.run(
    "INSERT INTO audit_log (actor_kind, action, outcome, agent_id) VALUES (?, ?, ?, ?)",
    ["agent", "session.start", "succeeded", "triage"],
  );
  old.close();

  const store = openStore(path);
  onTestFinished(() => {
    store.close();
  });

  expect(store.all("SELECT actor_kind, bot_id FROM audit_log")).toEqual([
    { actor_kind: "agent", bot_id: "triage" },
  ]);
  expect(
    store.all(
      "SELECT name FROM pragma_table_info('audit_log') WHERE name LIKE '%_id'",
    ),
  ).toEqual([
    { name: "actor_id" },
    { name: "bot_id" },
    { name: "session_id" },
    { name: "request_id" },
  ]);
  expect(() => {
    store.run("UPDATE audit_log SET bot_id = 'other'");
  }).toThrow("audit_log is append-only");
});

test("migration 6 drops the old plugin approvals, and a version needs its row before a pointer or grant names it", () => {
  const path = tempDatabasePath();
  const old = openSqlite(path);
  migrate(old, migrations.slice(0, 5));
  old.run(
    "INSERT INTO plugin_grants (plugin, folder, digest, kind, name) VALUES (?, ?, ?, ?, ?)",
    [
      "weather",
      "/opt/aphelion/plugins/weather",
      "abc123",
      "events",
      "bot.status",
    ],
  );
  old.run(
    "INSERT INTO plugin_installs (plugin, folder, digest) VALUES (?, ?, ?)",
    ["weather", "/opt/aphelion/plugins/weather", "abc123"],
  );
  old.close();

  const store = openStore(path);
  onTestFinished(() => {
    store.close();
  });

  expect(store.all("SELECT * FROM plugin_installs")).toEqual([]);
  expect(store.all("SELECT * FROM plugin_grants")).toEqual([]);
  expect(() => {
    store.run(
      "INSERT INTO plugin_installs (plugin, version) VALUES ('weather', '1.0.0')",
    );
  }).toThrow("FOREIGN KEY");
  expect(() => {
    store.run(
      "INSERT INTO plugin_grants (plugin, version, kind, name) VALUES ('weather', '1.0.0', 'events', 'bot.status')",
    );
  }).toThrow("FOREIGN KEY");
  store.run(
    "INSERT INTO plugin_versions (plugin, version, source, folder, files_digest) VALUES ('weather', '1.0.0', 'folder', '/opt/aphelion/plugins/weather', 'def456')",
  );
  store.run(
    "INSERT INTO plugin_grants (plugin, version, kind, name) VALUES ('weather', '1.0.0', 'events', 'bot.status')",
  );
  store.run(
    "INSERT INTO plugin_installs (plugin, version) VALUES ('weather', '1.0.0')",
  );
  expect(
    store.all("SELECT plugin, version, previous FROM plugin_installs"),
  ).toEqual([{ plugin: "weather", version: "1.0.0", previous: null }]);
});

test("migration 7 leaves every plugin that was installed switched on", () => {
  const path = tempDatabasePath();
  const old = openSqlite(path);
  migrate(old, migrations.slice(0, 6));
  old.run(
    "INSERT INTO plugin_versions (plugin, version, source, folder, files_digest) VALUES ('weather', '1.0.0', 'folder', '/opt/aphelion/plugins/weather', 'def456')",
  );
  old.run(
    "INSERT INTO plugin_installs (plugin, version) VALUES ('weather', '1.0.0')",
  );
  old.close();

  const store = openStore(path);
  onTestFinished(() => {
    store.close();
  });

  expect(store.all("SELECT plugin, enabled FROM plugin_installs")).toEqual([
    { plugin: "weather", enabled: 1 },
  ]);
  expect(() => {
    store.run("UPDATE plugin_installs SET enabled = 2");
  }).toThrow("CHECK");
});
