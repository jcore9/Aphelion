import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LineCounter, parseDocument, type Document } from "yaml";
import { z } from "zod";
import { configAreas, type Area, type Config } from "./areas";
import type { ConfigIssue } from "./issues";

export const defaultConfigDir = "/etc/aphelion";

export type Migrated = { file: string; from: number; to: number };

export type AreaResult<Value> =
  | { ok: true; value: Value; migratedFrom: number | undefined }
  | { ok: false; issues: ConfigIssue[] };

export type LoadResult =
  | { ok: true; config: Config; migrated: Migrated[] }
  | { ok: false; issues: ConfigIssue[] };

type Path = readonly PropertyKey[];

function fieldName(path: Path): string {
  return path
    .map((key, index) =>
      typeof key === "number"
        ? `[${String(key)}]`
        : `${index === 0 ? "" : "."}${String(key)}`,
    )
    .join("");
}

function valueAt(data: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      typeof node === "object" && node !== null
        ? (node as Record<PropertyKey, unknown>)[key]
        : undefined,
    data,
  );
}

function issueAt(
  file: string,
  document: Document,
  lines: LineCounter,
  path: Path,
  message: string,
): ConfigIssue {
  let node: unknown;
  for (let length = path.length; length > 0 && !node; length--) {
    node = document.getIn(path.slice(0, length), true);
  }
  const offset =
    node && typeof node === "object" && "range" in node
      ? (node as { range?: [number, number, number] }).range?.[0]
      : undefined;
  return {
    file,
    ...(offset === undefined ? {} : { position: lines.linePos(offset) }),
    ...(path.length === 0 ? {} : { field: fieldName(path) }),
    message,
  };
}

function schemaIssues(
  file: string,
  document: Document,
  lines: LineCounter,
  data: unknown,
  error: z.ZodError,
): ConfigIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) =>
        issueAt(file, document, lines, [...issue.path, key], "unknown field"),
      );
    }
    const missing =
      issue.code === "invalid_type" &&
      issue.path.length > 0 &&
      valueAt(data, issue.path) === undefined;
    return [
      issueAt(
        file,
        document,
        lines,
        issue.path,
        missing ? "is required" : issue.message,
      ),
    ];
  });
}

export function parseArea<A extends Area>(
  area: A,
  file: string,
  text: string,
): AreaResult<z.output<A["schema"]>> {
  const lines = new LineCounter();
  const document = parseDocument(text, {
    lineCounter: lines,
    prettyErrors: false,
  });
  if (document.errors.length > 0) {
    return {
      ok: false,
      issues: document.errors.map((error) => ({
        file,
        position: lines.linePos(error.pos[0]),
        message: error.message,
      })),
    };
  }

  let data: unknown;
  try {
    data = document.toJS();
  } catch (error) {
    return { ok: false, issues: [{ file, message: (error as Error).message }] };
  }
  const versionError = `must be a whole number from 1 to ${String(area.version)}, the newest version this Aphelion reads`;
  const header = z
    .looseObject(
      {
        version: z
          .int({ error: versionError })
          .min(1, { error: versionError })
          .max(area.version, { error: versionError }),
      },
      { error: "must be a YAML mapping with a version field" },
    )
    .safeParse(data);
  if (!header.success) {
    return {
      ok: false,
      issues: schemaIssues(file, document, lines, data, header.error),
    };
  }

  let migrated: Record<string, unknown> = header.data;
  for (let version = header.data.version; version < area.version; version++) {
    const migrate = area.migrations[version - 1];
    if (!migrate) break;
    migrated = { ...migrate(migrated), version: version + 1 };
  }

  const parsed = area.schema.safeParse(migrated);
  if (!parsed.success) {
    return {
      ok: false,
      issues: schemaIssues(file, document, lines, migrated, parsed.error),
    };
  }
  return {
    ok: true,
    value: parsed.data as z.output<A["schema"]>,
    migratedFrom:
      header.data.version < area.version ? header.data.version : undefined,
  };
}

async function readArea(
  file: string,
  version: number,
): Promise<string | ConfigIssue> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      file,
      message:
        code === "ENOENT"
          ? `is missing. Create it with the line \`version: ${String(version)}\`.`
          : `can't be read (${code ?? String(error)})`,
    };
  }
}

export async function loadConfig(
  dir: string = defaultConfigDir,
): Promise<LoadResult> {
  const entries = Object.entries(configAreas) as [keyof Config, Area][];
  const results = await Promise.all(
    entries.map(async ([name, area]) => {
      const file = join(dir, area.file);
      const text = await readArea(file, area.version);
      const result =
        typeof text === "string"
          ? parseArea(area, file, text)
          : { ok: false as const, issues: [text] };
      return { name, area, file, result };
    }),
  );

  const issues = results.flatMap(({ result }) =>
    result.ok ? [] : result.issues,
  );
  if (issues.length > 0) return { ok: false, issues };

  const config: Record<string, unknown> = {};
  const migrated: Migrated[] = [];
  for (const { name, area, file, result } of results) {
    if (!result.ok) continue;
    config[name] = result.value;
    if (result.migratedFrom !== undefined) {
      migrated.push({ file, from: result.migratedFrom, to: area.version });
    }
  }
  return { ok: true, config: config as Config, migrated };
}
