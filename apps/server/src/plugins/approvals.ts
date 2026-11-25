import { createHash } from "node:crypto";
import type { Database } from "../store/database";
import { permissionKinds, type Permission } from "./grants";
import { byteOrder } from "./tree-digest";

export interface ApprovedVersion {
  readonly plugin: string;
  readonly version: string;
  readonly source: "folder" | "release";
  readonly folder: string;
  readonly filesDigest: string;
  readonly repository: string | undefined;
  readonly grants: readonly Permission[];
}

export interface InstallRecord {
  readonly plugin: string;
  readonly current: ApprovedVersion;
  readonly previous: ApprovedVersion | undefined;
}

export interface Approval {
  readonly id: string;
  readonly version: string;
  readonly folder: string;
  readonly filesDigest: string | undefined;
}

export const approvalFor = (
  record: InstallRecord,
  devFolder: string | undefined,
): Approval => ({
  id: record.plugin,
  version: record.current.version,
  folder: record.current.folder,
  filesDigest:
    record.current.folder === devFolder
      ? undefined
      : record.current.filesDigest,
});

const sortedPermissions = (permissions: readonly Permission[]) =>
  permissions
    .map(({ kind, name }) => [kind, name] as const)
    .sort(
      ([kindA, nameA], [kindB, nameB]) =>
        byteOrder(kindA, kindB) || byteOrder(nameA, nameB),
    );

export const approvalToken = (input: {
  readonly id: string;
  readonly fromVersion: string | undefined;
  readonly version: string;
  readonly folder: string;
  readonly permissions: readonly Permission[];
  readonly filesDigest: string;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "aphelion-approval-v1",
        input.id,
        input.fromVersion ?? null,
        input.version,
        input.folder,
        sortedPermissions(input.permissions),
        input.filesDigest,
      ]),
    )
    .digest("hex");

const approvedParts = (approved: ApprovedVersion) => [
  approved.version,
  approved.folder,
  approved.filesDigest,
  sortedPermissions(approved.grants),
];

export const updateToken = (from: ApprovedVersion, next: ApprovedVersion) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        "aphelion-update-v1",
        next.plugin,
        approvedParts(from),
        approvedParts(next),
      ]),
    )
    .digest("hex");

export function recordVersion(db: Database, approved: ApprovedVersion): void {
  const { plugin, version } = approved;
  db.transaction(() => {
    db.run(
      `INSERT INTO plugin_versions (plugin, version, source, folder, files_digest, repository)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (plugin, version) DO UPDATE SET source = excluded.source,
         folder = excluded.folder, files_digest = excluded.files_digest,
         repository = excluded.repository`,
      [
        plugin,
        version,
        approved.source,
        approved.folder,
        approved.filesDigest,
        approved.repository ?? null,
      ],
    );
    db.run("DELETE FROM plugin_grants WHERE plugin = ? AND version = ?", [
      plugin,
      version,
    ]);
    for (const { kind, name } of approved.grants) {
      db.run(
        "INSERT INTO plugin_grants (plugin, version, kind, name) VALUES (?, ?, ?, ?)",
        [plugin, version, kind, name],
      );
    }
    db.run(
      `INSERT INTO plugin_installs (plugin, version, previous) VALUES (?, ?, NULL)
       ON CONFLICT (plugin) DO UPDATE SET version = excluded.version,
         previous = CASE WHEN version = excluded.version THEN previous ELSE version END`,
      [plugin, version],
    );
  });
}

const kindOf = (value: unknown) => {
  const kind = permissionKinds.find((known) => known === value);
  if (kind === undefined)
    throw new Error(`unknown grant kind ${String(value)}`);
  return kind;
};

function readVersion(
  db: Database,
  plugin: string,
  version: string,
): ApprovedVersion {
  const [row] = db.all(
    "SELECT source, folder, files_digest, repository FROM plugin_versions WHERE plugin = ? AND version = ?",
    [plugin, version],
  );
  if (row === undefined) {
    throw new Error(`plugin ${plugin} has no version ${version}`);
  }
  return {
    plugin,
    version,
    source: row["source"] === "release" ? "release" : "folder",
    folder: String(row["folder"]),
    filesDigest: String(row["files_digest"]),
    repository:
      row["repository"] === null ? undefined : String(row["repository"]),
    grants: db
      .all(
        "SELECT kind, name FROM plugin_grants WHERE plugin = ? AND version = ? ORDER BY kind, name",
        [plugin, version],
      )
      .map((grant) => ({
        kind: kindOf(grant["kind"]),
        name: String(grant["name"]),
      })),
  };
}

export function readInstall(
  db: Database,
  plugin: string,
): InstallRecord | undefined {
  return db.transaction(() => {
    const [row] = db.all(
      "SELECT version, previous FROM plugin_installs WHERE plugin = ?",
      [plugin],
    );
    if (row === undefined) return undefined;
    const previous = row["previous"];
    return {
      plugin,
      current: readVersion(db, plugin, String(row["version"])),
      previous:
        previous === null
          ? undefined
          : readVersion(db, plugin, String(previous)),
    };
  });
}

export function installedPlugins(db: Database): InstallRecord[] {
  return db
    .all("SELECT plugin FROM plugin_installs ORDER BY plugin")
    .flatMap((row) => readInstall(db, String(row["plugin"])) ?? []);
}

export function switchOffPlugins(db: Database): string[] {
  return db
    .all(
      "UPDATE plugin_installs SET enabled = 0 WHERE enabled = 1 RETURNING plugin",
    )
    .map((row) => String(row["plugin"]));
}

export function switchedOffPlugins(db: Database): string[] {
  return db
    .all("SELECT plugin FROM plugin_installs WHERE enabled = 0 ORDER BY plugin")
    .map((row) => String(row["plugin"]));
}
