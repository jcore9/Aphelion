import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { configAreas } from "./areas";
import type { ConfigIssue } from "./issues";

export type Owner = { uid: number; gid: number };

export type Lstat = (
  path: string,
) => Promise<{ uid: number; gid: number; mode: number }>;

type Rule = { path: string; type: number; typeName: string; maxMode: number };

function rules(dir: string): Rule[] {
  return [
    {
      path: dir,
      type: constants.S_IFDIR,
      typeName: "a directory",
      maxMode: 0o750,
    },
    ...Object.values(configAreas).map((area) => ({
      path: join(dir, area.file),
      type: constants.S_IFREG,
      typeName: "a regular file, not a symlink",
      maxMode: 0o644,
    })),
  ];
}

const octal = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`;

function ruleIssues(
  rule: Rule,
  owner: Owner,
  stat: { uid: number; gid: number; mode: number },
): string[] {
  if ((stat.mode & constants.S_IFMT) !== rule.type) {
    return [`must be ${rule.typeName}`];
  }
  const mode = stat.mode & 0o777;
  return [
    stat.uid !== owner.uid &&
      `is owned by uid ${String(stat.uid)}, not the server's uid ${String(owner.uid)}`,
    stat.gid !== owner.gid &&
      `has group gid ${String(stat.gid)}, not the server's gid ${String(owner.gid)}`,
    (mode & ~rule.maxMode) !== 0 &&
      `has mode ${octal(mode)}, which is looser than ${octal(rule.maxMode)}`,
  ].filter((message): message is string => typeof message === "string");
}

async function checkRules(
  list: Rule[],
  owner: Owner,
  stat: Lstat,
): Promise<ConfigIssue[]> {
  const checks = list.map(async (rule) => {
    try {
      const messages = ruleIssues(rule, owner, await stat(rule.path));
      return messages.map((message) => ({ file: rule.path, message }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return [
        {
          file: rule.path,
          message:
            code === "ENOENT"
              ? "is missing"
              : `can't be checked (${code ?? String(error)})`,
        },
      ];
    }
  });
  return (await Promise.all(checks)).flat();
}

export function checkConfigPermissions(
  dir: string,
  owner: Owner,
  stat: Lstat = lstat,
): Promise<ConfigIssue[]> {
  return checkRules(rules(dir), owner, stat);
}

export function checkStatePermissions(
  dir: string,
  owner: Owner,
  stat: Lstat = lstat,
): Promise<ConfigIssue[]> {
  const rule = {
    path: dir,
    type: constants.S_IFDIR,
    typeName: "a directory",
    maxMode: 0o700,
  };
  return checkRules([rule], owner, stat);
}
