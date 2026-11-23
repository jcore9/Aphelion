import type { PluginManifest } from "@aphelion/plugin-sdk";
import { Context, Effect, Layer } from "effect";
import type { Database } from "../store/database";

const kinds = [
  "events",
  "secrets",
  "network",
  "uiSlots",
] as const satisfies readonly (keyof PluginManifest["permissions"])[];

export interface Permission {
  readonly kind: (typeof kinds)[number];
  readonly name: string;
}

export class PluginGrants extends Context.Service<
  PluginGrants,
  {
    readonly allows: (
      plugin: string,
      permission: Permission,
      folder: string,
      digest: string,
    ) => Effect.Effect<boolean>;
  }
>()("aphelion/plugins/PluginGrants") {
  static readonly refuseAll = Layer.succeed(PluginGrants, {
    allows: () => Effect.succeed(false),
  });
}

export const permissionList = (manifest: PluginManifest): Permission[] =>
  kinds.flatMap((kind) =>
    [...new Set(manifest.permissions[kind])].map((name) => ({ kind, name })),
  );

export function declaresPermission(
  manifest: PluginManifest,
  { kind, name }: Permission,
): boolean {
  const names: readonly string[] = manifest.permissions[kind];
  return names.includes(name);
}

export function recordGrants(
  db: Database,
  installation: {
    readonly manifest: PluginManifest;
    readonly folder: string;
    readonly digest: string;
  },
  permissions: readonly Permission[],
): void {
  const { manifest, folder, digest } = installation;
  if (
    permissions.some((permission) => !declaresPermission(manifest, permission))
  ) {
    throw new Error("a grant must be declared in the manifest");
  }
  db.transaction(() => {
    db.run(
      "INSERT INTO plugin_installs (plugin, folder, digest) VALUES (?, ?, ?) ON CONFLICT (plugin) DO UPDATE SET folder = excluded.folder, digest = excluded.digest",
      [manifest.id, folder, digest],
    );
    db.run("DELETE FROM plugin_grants WHERE plugin = ?", [manifest.id]);
    for (const { kind, name } of permissions) {
      db.run(
        "INSERT INTO plugin_grants (plugin, folder, digest, kind, name) VALUES (?, ?, ?, ?, ?)",
        [manifest.id, folder, digest, kind, name],
      );
    }
  });
}

export const sqlitePluginGrants = (db: Database) =>
  Layer.succeed(PluginGrants, {
    allows: (plugin, { kind, name }, folder, digest) =>
      Effect.try(
        () =>
          db.all(
            "SELECT 1 FROM plugin_grants WHERE plugin = ? AND kind = ? AND name = ? AND folder = ? AND digest = ?",
            [plugin, kind, name, folder, digest],
          ).length > 0,
      ).pipe(Effect.orElseSucceed(() => false)),
  });

export function installedPluginFolders(db: Database): string[] {
  return db
    .all("SELECT folder FROM plugin_installs ORDER BY plugin")
    .map((row) => String(row["folder"]));
}
