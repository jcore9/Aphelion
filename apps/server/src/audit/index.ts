import {
  defaultRules,
  redact,
  redactText,
  type Fields,
  type FixedText,
  type RedactionRules,
} from "../log";
import type { Database } from "../store";

export const actorKinds = ["server", "cli", "device", "bot", "plugin"] as const;

export const outcomes = ["allowed", "denied", "succeeded", "failed"] as const;

export type Actor =
  | { readonly kind: "server" | "cli" }
  | { readonly kind: "device" | "bot" | "plugin"; readonly id: string };

export type Outcome = (typeof outcomes)[number];

function allowed(
  list: readonly string[],
  value: string,
  column: string,
): string {
  if (!list.includes(value)) {
    throw new TypeError(
      `audit_log ${column} must be one of ${list.join(", ")}.`,
    );
  }
  return value;
}

export interface AuditEntry<A extends string = string> {
  readonly actor: Actor;
  readonly action: A;
  readonly outcome: Outcome;
  readonly botId?: string;
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
      (actor_kind, actor_id, action, outcome, bot_id, session_id, request_id, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id`,
    [
      allowed(actorKinds, entry.actor.kind, "actor_kind"),
      text("id" in entry.actor ? entry.actor.id : undefined),
      text(entry.action),
      allowed(outcomes, entry.outcome, "outcome"),
      text(entry.botId),
      text(entry.sessionId),
      text(entry.requestId),
      JSON.stringify(detailObject(redactDetail(entry, rules))),
    ],
  );
  return Number(row?.["id"]);
}
