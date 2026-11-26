import type { Migration } from "../migrate";
import { auditLog } from "./0001-audit-log";
import { devices } from "./0002-devices";
import { auditBotId } from "./0003-audit-bot-id";
import { pluginGrants } from "./0004-plugin-grants";
import { pluginInstalls } from "./0005-plugin-installs";
import { pluginVersions } from "./0006-plugin-versions";
import { pluginEnabled } from "./0007-plugin-enabled";
import { messageHistory } from "./0008-message-history";

export const migrations: readonly Migration[] = [
  auditLog,
  devices,
  auditBotId,
  pluginGrants,
  pluginInstalls,
  pluginVersions,
  pluginEnabled,
  messageHistory,
];
