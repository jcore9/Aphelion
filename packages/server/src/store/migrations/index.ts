import type { Migration } from "../migrate";
import { auditLog } from "./0001-audit-log";

export const migrations: readonly Migration[] = [auditLog];
