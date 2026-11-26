import { appendAudit } from "../audit";
import { revokeAllDevices } from "../devices";
import { switchedOffPlugins, switchOffPlugins } from "../plugins/approvals";
import { renewStreamId, type Database } from "../store";

export const restoreAction = "restore.finish";

export type RestoreFinish = { readonly switchedOff: string[] };

export function finishRestore(
  db: Database,
  now: Date = new Date(),
): RestoreFinish {
  return db.transaction(() => {
    renewStreamId(db);
    const devices = revokeAllDevices(db, now);
    const plugins = switchOffPlugins(db).sort();
    appendAudit(db, {
      actor: { kind: "cli" },
      action: restoreAction,
      outcome: "succeeded",
      detail: { devices, plugins },
    });
    return { switchedOff: switchedOffPlugins(db) };
  });
}
