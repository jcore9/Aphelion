import type { PluginManifest } from "@aphelion/plugin-sdk";
import { Context, Effect, Layer } from "effect";
import type { Database } from "../store/database";
import type { Approval } from "./approvals";

export const permissionKinds = [
  "events",
  "secrets",
  "network",
  "uiSlots",
] as const satisfies readonly (keyof PluginManifest["permissions"])[];

export interface Permission {
  readonly kind: (typeof permissionKinds)[number];
  readonly name: string;
}

export class PluginGrants extends Context.Service<
  PluginGrants,
  {
    readonly hasApproval: (approval: Approval) => Effect.Effect<boolean>;
    readonly allows: (
      approval: Approval,
      permission: Permission,
    ) => Effect.Effect<boolean>;
  }
>()("aphelion/plugins/PluginGrants") {}

export const permissionList = (manifest: PluginManifest): Permission[] =>
  permissionKinds.flatMap((kind) =>
    [...new Set(manifest.permissions[kind])].map((name) => ({ kind, name })),
  );

export function declaresPermission(
  manifest: PluginManifest,
  { kind, name }: Permission,
): boolean {
  const names: readonly string[] = manifest.permissions[kind];
  return names.includes(name);
}

const approvedVersion = `SELECT 1 FROM plugin_versions v
  WHERE v.plugin = ? AND v.version = ? AND v.folder = ?
    AND (? IS NULL OR v.files_digest = ?)`;

const approvalParams = ({ id, version, folder, filesDigest }: Approval) =>
  [id, version, folder, filesDigest ?? null, filesDigest ?? null] as const;

export const sqlitePluginGrants = (db: Database) => {
  const exists = (sql: string, params: readonly (string | null)[]) =>
    Effect.try(() => db.all(sql, params).length > 0).pipe(
      Effect.orElseSucceed(() => false),
    );
  return Layer.succeed(PluginGrants, {
    hasApproval: (approval) =>
      exists(approvedVersion, approvalParams(approval)),
    allows: (approval, { kind, name }) =>
      exists(
        `${approvedVersion}
         AND EXISTS (SELECT 1 FROM plugin_grants g
           WHERE g.plugin = v.plugin AND g.version = v.version
             AND g.kind = ? AND g.name = ?)`,
        [...approvalParams(approval), kind, name],
      ),
  });
};
