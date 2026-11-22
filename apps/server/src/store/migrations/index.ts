import type { Migration } from "../migrate";
import { auditLog } from "./0001-audit-log";
import { devices } from "./0002-devices";
import { auditBotId } from "./0003-audit-bot-id";
import { pluginGrants } from "./0004-plugin-grants";

export const migrations: readonly Migration[] = [
  auditLog,
  devices,
  auditBotId,
  pluginGrants,
];
