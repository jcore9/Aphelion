import type { Migration } from "../migrate";

export const auditBotId: Migration = {
  version: 3,
  name: "audit-bot-id",
  sql: `ALTER TABLE audit_log RENAME COLUMN agent_id TO bot_id;`,
};
