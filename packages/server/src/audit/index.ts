import {
  defaultRules,
  redact,
  redactText,
  type Fields,
  type FixedText,
  type RedactionRules,
} from "../log";
import type { Database } from "../store";

export type Actor =
  | { readonly kind: "server" | "cli" }
  | { readonly kind: "device" | "agent" | "plugin"; readonly id: string };

export type Outcome = "allowed" | "denied" | "succeeded" | "failed";

export interface AuditEntry<A extends string = string> {
  readonly actor: Actor;
  readonly action: A;
  readonly outcome: Outcome;
  readonly agentId?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly detail?: Fields;
}

function detailObject(detail: unknown): object {
  return typeof detail === "object" && detail !== null && !Array.isArray(detail)
    ? detail
    : { unreadable: true };
}

function redactDetail(entry: AuditEntry, rules: RedactionRules): unknown {
  try {
    return redact(entry.detail ?? {}, rules);
  } catch {
    return undefined;
  }
}

export function appendAudit<A extends string>(
  db: Database,
  entry: AuditEntry<A & FixedText<A>>,
  rules: RedactionRules = defaultRules,
): number {
  const text = (value: string | undefined) =>
    value === undefined ? null : redactText(value, rules);
  const [row] = db.all(
    `INSERT INTO audit_log
      (actor_kind, actor_id, action, outcome, agent_id, session_id, request_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    [
      text(entry.actor.kind),
      text("id" in entry.actor ? entry.actor.id : undefined),
      text(entry.action),
      text(entry.outcome),
      text(entry.agentId),
      text(entry.sessionId),
      text(entry.requestId),
      JSON.stringify(detailObject(redactDetail(entry, rules))),
    ],
  );
  return Number(row?.["id"]);
}
