import type { Migration } from "../migrate";

export const pluginEnabled: Migration = {
  version: 7,
  name: "plugin-enabled",
  sql: `ALTER TABLE plugin_installs
    ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));`,
};
