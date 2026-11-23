import type { Migration } from "../migrate";

export const pluginInstalls: Migration = {
  version: 5,
  name: "plugin-installs",
  sql: `CREATE TABLE plugin_installs (
    plugin TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    digest TEXT NOT NULL
  ) STRICT;
  INSERT INTO plugin_installs (plugin, folder, digest)
    SELECT plugin, folder, digest FROM plugin_grants GROUP BY plugin;`,
};
