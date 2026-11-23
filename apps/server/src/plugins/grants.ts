import type { PluginManifest } from "@aphelion/plugin-sdk";
import { Context, Effect, Layer } from "effect";
import type { Database } from "../store/database";

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
    readonly allows: (
      plugin: string,
      version: string,
      permission: Permission,
    ) => Effect.Effect<boolean>;
  }
>()("aphelion/plugins/PluginGrants") {
  static readonly refuseAll = Layer.succeed(PluginGrants, {
    allows: () => Effect.succeed(false),
  });
}

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

export const sqlitePluginGrants = (db: Database) =>
  Layer.succeed(PluginGrants, {
    allows: (plugin, version, { kind, name }) =>
      Effect.try(
        () =>
          db.all(
            "SELECT 1 FROM plugin_grants WHERE plugin = ? AND version = ? AND kind = ? AND name = ?",
            [plugin, version, kind, name],
          ).length > 0,
      ).pipe(Effect.orElseSucceed(() => false)),
  });
