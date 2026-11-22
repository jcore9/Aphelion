import { z } from "zod";
import { configAreas } from "./areas";

type JsonSchema = {
  type?: string;
  const?: unknown;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

export const referenceBegin =
  "<!-- Generated from packages/server/src/config/areas.ts. Regenerate: bun --bun vitest run -u packages/server/src/config -->";
export const referenceEnd = "<!-- End of generated section -->";

export function jsonSchemaFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.values(configAreas).map((area) => [
      area.file.replace(/\.yaml$/, ".schema.json"),
      `${JSON.stringify(z.toJSONSchema(area.schema, { target: "draft-7" }), null, 2)}\n`,
    ]),
  );
}

function typeName(schema: JsonSchema): string {
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (schema.type === "array" && schema.items) {
    return `list of ${schema.items.type === "object" ? "objects" : `${typeName(schema.items)}s`}`;
  }
  return schema.type ?? "any";
}

function rows(schema: JsonSchema, prefix: string): string[] {
  return Object.entries(schema.properties ?? {}).flatMap(([key, field]) => {
    const name = `${prefix}${key}`;
    const required = schema.required?.includes(key) ? "yes" : "no";
    const row = `| \`${name}\` | ${typeName(field)} | ${required} | ${field.description ?? ""} |`;
    const nested =
      field.type === "array" && field.items?.type === "object"
        ? rows(field.items, `${name}[].`)
        : [];
    return [row, ...nested];
  });
}

function areaSection(
  file: string,
  version: number,
  schema: JsonSchema,
): string {
  return [
    `### \`${file}\`, version ${String(version)}`,
    "",
    schema.description ?? "",
    "",
    "| Field | Type | Required | Description |",
    "| --- | --- | --- | --- |",
    ...rows(schema, ""),
  ].join("\n");
}

export function fieldReference(): string {
  const sections = Object.values(configAreas).map((area) =>
    areaSection(
      area.file,
      area.version,
      z.toJSONSchema(area.schema, { target: "draft-7" }) as JsonSchema,
    ),
  );
  return [referenceBegin, "", sections.join("\n\n"), "", referenceEnd].join(
    "\n",
  );
}

export function withFieldReference(markdown: string): string {
  const begin = markdown.indexOf(referenceBegin);
  const end = markdown.indexOf(referenceEnd);
  if (begin === -1 || end < begin) {
    throw new Error("config.md has lost its generated-section markers");
  }
  return `${markdown.slice(0, begin)}${fieldReference()}${markdown.slice(end + referenceEnd.length)}`;
}
