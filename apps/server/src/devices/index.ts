import { z } from "zod";
import { appendAudit } from "../audit";
import { maskSecretValue } from "../log";
import type { Database } from "../store";
import {
  deviceId,
  newToken,
  parseToken,
  tokenMatches,
  type DeviceId,
} from "./token";

export { deviceId, type DeviceId } from "./token";

export const deviceName = z.string().regex(/^(?!\s)[^\p{Cc}]{1,64}(?<!\s)$/u, {
  error:
    "must be 1 to 64 characters, with no control characters and no spaces at either end",
});

export const defaultLifetimeDays = 90;

export const lifetimeDays = z
  .int({ error: "must be a whole number of days from 1 to 365" })
  .min(1, { error: "must be a whole number of days from 1 to 365" })
  .max(365, { error: "must be a whole number of days from 1 to 365" });

const addInput = z.strictObject({
  name: deviceName,
  lifetimeDays: lifetimeDays.default(defaultLifetimeDays),
});

export interface Device {
  readonly id: DeviceId;
}

export interface AddedDevice extends Device {
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly token: string;
}

const day = 24 * 60 * 60 * 1000;

export function addDevice(
  db: Database,
  input: z.input<typeof addInput>,
  now: Date = new Date(),
): AddedDevice {
  const { name, lifetimeDays } = addInput.parse(input);
  const { id, token, hash } = newToken();
  maskSecretValue(token);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + lifetimeDays * day).toISOString();
  db.transaction(() => {
    db.run(
      `INSERT INTO devices (id, name, token_hash, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?)`,
      [id, name, hash, createdAt, expiresAt],
    );
    appendAudit(db, {
      actor: { kind: "cli" },
      action: "device.add",
      outcome: "succeeded",
      detail: { device: id, name, expiresAt },
    });
  });
  return { id, name, createdAt, expiresAt, token };
}

export function revokeDevice(
  db: Database,
  id: string,
  now: Date = new Date(),
): boolean {
  const parsed = deviceId.safeParse(id);
  return db.transaction(() => {
    const revoked =
      parsed.success &&
      db.all(
        `UPDATE devices SET revoked_at = ?
          WHERE id = ? AND revoked_at IS NULL RETURNING id`,
        [now.toISOString(), parsed.data],
      ).length === 1;
    appendAudit(db, {
      actor: { kind: "cli" },
      action: "device.revoke",
      outcome: revoked ? "succeeded" : "failed",
      detail: parsed.success ? { device: parsed.data } : {},
    });
    return revoked;
  });
}

export function revokeAllDevices(
  db: Database,
  now: Date = new Date(),
): DeviceId[] {
  return db
    .all(
      `UPDATE devices SET revoked_at = ?
        WHERE revoked_at IS NULL RETURNING id`,
      [now.toISOString()],
    )
    .map((row) => deviceId.parse(row["id"]));
}

export interface ListedDevice {
  readonly id: DeviceId;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export function listDevices(db: Database): ListedDevice[] {
  return db
    .all(
      `SELECT id, name, created_at, expires_at, revoked_at
        FROM devices ORDER BY created_at, id`,
    )
    .map((row) => ({
      id: deviceId.parse(row["id"]),
      name: String(row["name"]),
      createdAt: String(row["created_at"]),
      expiresAt: String(row["expires_at"]),
      revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
    }));
}

export type Refusal =
  "missing" | "malformed" | "unknown" | "wrong" | "revoked" | "expired";

export type Verdict =
  | { readonly ok: true; readonly device: Device }
  | {
      readonly ok: false;
      readonly reason: Refusal;
      readonly claimed?: DeviceId;
    };

interface DeviceRow {
  readonly hash: Uint8Array;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

function findDevice(db: Database, id: DeviceId): DeviceRow | undefined {
  const [row] = db.all(
    "SELECT token_hash, expires_at, revoked_at FROM devices WHERE id = ?",
    [id],
  );
  if (row === undefined) return undefined;
  return {
    hash: row["token_hash"] as Uint8Array,
    expiresAt: String(row["expires_at"]),
    revokedAt: row["revoked_at"] === null ? null : String(row["revoked_at"]),
  };
}

function refusal(row: DeviceRow, now: Date): "revoked" | "expired" | undefined {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt <= now.toISOString()) return "expired";
  return undefined;
}

const bearer = /^Bearer ([^\s]+)$/i;

export function checkAuthorization(
  db: Database,
  header: string | undefined,
  now: Date = new Date(),
): Verdict {
  if (header === undefined) return { ok: false, reason: "missing" };
  const parsed = parseToken(bearer.exec(header)?.[1] ?? "");
  const row = parsed && findDevice(db, parsed.id);
  const matches = tokenMatches(parsed?.token, row?.hash);
  if (parsed === undefined) return { ok: false, reason: "malformed" };
  const claimed = parsed.id;
  if (row === undefined) return { ok: false, reason: "unknown", claimed };
  if (!matches) return { ok: false, reason: "wrong", claimed };
  const reason = refusal(row, now);
  if (reason !== undefined) return { ok: false, reason, claimed };
  return { ok: true, device: { id: parsed.id } };
}

export function isDeviceActive(
  db: Database,
  id: DeviceId,
  now: Date = new Date(),
): boolean {
  const row = findDevice(db, id);
  return row !== undefined && refusal(row, now) === undefined;
}

export interface FailureAuditLimit {
  readonly rows: number;
  readonly windowMs: number;
}

export const defaultFailureAuditLimit: FailureAuditLimit = {
  rows: 10,
  windowMs: 60_000,
};

export function failureAuditor(
  db: Database,
  { rows, windowMs }: FailureAuditLimit = defaultFailureAuditLimit,
): (verdict: Verdict & { ok: false }, now: Date) => void {
  let windowStart = Number.NEGATIVE_INFINITY;
  let written = 0;
  let suppressed = 0;
  return ({ reason, claimed }, now) => {
    if (reason === "missing") return;
    if (now.getTime() - windowStart >= windowMs) {
      windowStart = now.getTime();
      written = 0;
    }
    if (written >= rows) {
      suppressed += 1;
      return;
    }
    appendAudit(db, {
      actor: { kind: "server" },
      action: "device.authenticate",
      outcome: "denied",
      detail: {
        reason,
        ...(claimed && { claimedDevice: claimed }),
        ...(suppressed > 0 && { suppressedBefore: suppressed }),
      },
    });
    written += 1;
    suppressed = 0;
  };
}
