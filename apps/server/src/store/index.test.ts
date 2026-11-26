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

test("migration 8 keeps a turn's end time and reason together, a saved event valid JSON, and an event's turn real", () => {
  const store = openStore(tempDatabasePath());
  onTestFinished(() => {
    store.close();
  });
  const id = "0192f0a0-0000-7000-8000-000000000001";
  const insertEvent = (
    turn: string | null,
    payload: string,
    bot = "triage",
  ) => {
    store.run(
      "INSERT INTO events (id, server_id, position, bot, turn, run, epoch, format, kind, payload, at) VALUES (?, ?, 1, ?, ?, 1, 1, 1, 'text.delta', ?, 0)",
      [id, id, bot, turn, payload],
    );
  };

  expect(() => {
    store.run(
      "INSERT INTO turns (id, server_id, bot, started_at, ended_at) VALUES ('t1', ?, 'triage', 0, 5)",
      [id],
    );
  }).toThrow("CHECK");
  store.run(
    "INSERT INTO turns (id, server_id, bot, started_at, ended_at, end_reason) VALUES ('t1', ?, 'triage', 0, 5, 'completed')",
    [id],
  );
  expect(() => {
    insertEvent("t1", "not json");
  }).toThrow("CHECK");
  expect(() => {
    insertEvent("missing", "{}");
  }).toThrow("FOREIGN KEY");
  expect(() => {
    insertEvent("t1", "{}", "other");
  }).toThrow("FOREIGN KEY");
  insertEvent("t1", '{"text":"hi"}');
  expect(store.all("SELECT turn, format, kind FROM events")).toEqual([
    { turn: "t1", format: 1, kind: "text.delta" },
  ]);
});

test("migration 9 keys a command by device and id, and keeps a result with its state", () => {
  const store = openStore(tempDatabasePath());
  onTestFinished(() => {
    store.close();
  });
  const insert = (
    device: string,
    state: string,
    result: string | null,
    id = "c1",
  ) => {
    store.run(
      "INSERT INTO commands (device, id, name, state, result, created_at) VALUES (?, ?, 'bot.prompt', ?, ?, 0)",
      [device, id, state, result],
    );
  };

  insert("d1", "running", null);
  insert("d2", "running", null);
  expect(() => {
    insert("d1", "running", null);
  }).toThrow("UNIQUE");
  expect(() => {
    insert("d1", "paused", null, "c2");
  }).toThrow("CHECK");
  expect(() => {
    insert("d1", "running", "{}", "c2");
  }).toThrow("CHECK");
  expect(() => {
    insert("d1", "done", null, "c2");
  }).toThrow("CHECK");
  insert("d1", "done", '{"turn":"t1"}', "c2");
  insert("d1", "failed", "interrupted", "c3");
  expect(
    store.all("SELECT name FROM pragma_index_list('events') ORDER BY name"),
  ).toContainEqual({ name: "events_bot" });
});
