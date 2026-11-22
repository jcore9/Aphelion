import { Effect } from "effect";
import {
  checkConfigPermissions,
  checkStatePermissions,
  loadConfig,
  type Config,
  type ConfigIssue,
  type Migrated,
  type Owner,
} from "../config";

export type Checked =
  | {
      readonly ok: true;
      readonly config: Config;
      readonly migrated: Migrated[];
    }
  | { readonly ok: false; readonly issues: ConfigIssue[] };

export function currentOwner(): Owner {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Aphelion runs only on Linux");
  }
  return { uid, gid };
}

export const checkDirs = (configDir: string, stateDir: string) =>
  Effect.promise(async (): Promise<Checked> => {
    const owner = currentOwner();
    const [loaded, configModes, stateModes] = await Promise.all([
      loadConfig(configDir),
      checkConfigPermissions(configDir, owner),
      checkStatePermissions(stateDir, owner),
    ]);
    const issues = [
      ...(loaded.ok ? [] : loaded.issues),
      ...configModes,
      ...stateModes,
    ];
    if (!loaded.ok || issues.length > 0) return { ok: false, issues };
    return { ok: true, config: loaded.config, migrated: loaded.migrated };
  });

export const migratedNote = ({ file, from, to }: Migrated) =>
  `${file}: is at version ${String(from)}, read as version ${String(to)}. The file on disk is unchanged.`;
