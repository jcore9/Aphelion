import type { Migration } from "../migrate";

export const pluginGrants: Migration = {
  version: 4,
  name: "plugin-grants",
  sql: `CREATE TABLE plugin_grants (
    plugin TEXT NOT NULL,
    folder TEXT NOT NULL,
    digest TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('events', 'secrets', 'network', 'uiSlots')),
    name TEXT NOT NULL,
    PRIMARY KEY (plugin, kind, name)
  ) STRICT;`,
};
