import { defaultRules, redact, type Fields, type RedactionRules } from "../log";
import type { Database } from "../store";

export type Actor =
  | { readonly kind: "server" | "cli" }
  | { readonly kind: "device" | "agent" | "plugin"; readonly id: string };

export type Outcome = "allowed" | "denied" | "succeeded" | "failed";

export interface AuditEntry {
  readonly actor: Actor;
  readonly action: string;
  readonly outcome: Outcome;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly detail?: Fields;
}

export function appendAudit(
  db: Database,
  entry: AuditEntry,
  rules: RedactionRules = defaultRules,
): number {
  const [row] = db.all(
    `INSERT INTO audit_log
      (actor_kind, actor_id, action, outcome, agent_id, session_id, request_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    [
      entry.actor.kind,
      "id" in entry.actor ? entry.actor.id : null,
      entry.action,
      entry.outcome,
      entry.agentId ?? null,
      entry.sessionId ?? null,
      entry.requestId ?? null,
      JSON.stringify(redact(entry.detail ?? {}, rules)),
    ],
  );
  return Number(row?.["id"]);
}
