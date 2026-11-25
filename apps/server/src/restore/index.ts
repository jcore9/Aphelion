import { appendAudit } from "../audit";
import { revokeAllDevices } from "../devices";
import { switchedOffPlugins, switchOffPlugins } from "../plugins/approvals";
import type { Database } from "../store";

export const restoreAction = "restore.finish";

export type RestoreFinish =
  | { readonly kind: "finished"; readonly switchedOff: string[] }
  | { readonly kind: "enrolled-since" };

export function finishRestore(
  db: Database,
  now: Date = new Date(),
): RestoreFinish {
  return db.transaction(() => {
    const enrolledSince = db.all(
      `SELECT 1 FROM devices
        WHERE revoked_at IS NULL
          AND created_at > (SELECT max(at) FROM audit_log WHERE action = ?)`,
      [restoreAction],
    );
    if (enrolledSince.length > 0) return { kind: "enrolled-since" };
    const devices = revokeAllDevices(db, now);
    const plugins = switchOffPlugins(db).sort();
    appendAudit(db, {
      actor: { kind: "cli" },
      action: restoreAction,
      outcome: "succeeded",
      detail: { devices, plugins },
    });
    return { kind: "finished", switchedOff: switchedOffPlugins(db) };
  });
}
