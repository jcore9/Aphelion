import type { Migration } from "../migrate";

export const pluginVersions: Migration = {
  version: 6,
  name: "plugin-versions",
  sql: `DROP TABLE plugin_grants;
  DROP TABLE plugin_installs;
  CREATE TABLE plugin_versions (
    plugin TEXT NOT NULL,
    version TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('folder', 'release')),
    folder TEXT NOT NULL,
    files_digest TEXT NOT NULL,
    repository TEXT,
    PRIMARY KEY (plugin, version)
  ) STRICT;
  CREATE TABLE plugin_installs (
    plugin TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    previous TEXT,
    FOREIGN KEY (plugin, version) REFERENCES plugin_versions (plugin, version),
    FOREIGN KEY (plugin, previous) REFERENCES plugin_versions (plugin, version)
  ) STRICT;
  CREATE TABLE plugin_grants (
    plugin TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('events', 'secrets', 'network', 'uiSlots')),
    name TEXT NOT NULL,
    PRIMARY KEY (plugin, version, kind, name),
    FOREIGN KEY (plugin, version) REFERENCES plugin_versions (plugin, version)
  ) STRICT;`,
};
