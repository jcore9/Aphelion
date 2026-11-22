import { satisfies, validRange } from "semver";
import { z } from "zod";

export const pluginApiVersion = "0.1.0";

export const pluginManifestFile = "aphelion-plugin.json";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  error:
    "must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter",
});

const version = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/,
    { error: "must be a semver version, such as 1.0.0" },
  );

const apiRange = z
  .string()
  .refine(
    (range) =>
      range.split("||").every((part) => part.trim() !== "") &&
      validRange(range) !== null,
    { error: "must be an npm semver range, such as ^0.1.0" },
  );

const entry = z.string().regex(/^(?!\/)(?!.*\\)(?!(.*\/)?\.\.(\/|$)).+$/, {
  error:
    "must be a relative path inside the plugin's folder, such as dist/index.js",
});

const dottedName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/, {
    error: "must be words joined by dots, such as approval.requested",
  });

const schemeName = /^[a-z][a-z0-9+.-]*$/;

const secretReference = z.templateLiteral(
  [z.string().regex(schemeName), "://", z.string().min(1)],
  { error: "must be a secret reference, such as op://vault/item/field" },
);

const host = z
  .string()
  .regex(
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
    { error: "must be a lowercase hostname, such as api.github.com" },
  );

const scheme = z.string().regex(schemeName, {
  error: "must be a reference scheme without ://, such as op",
});

const list = <Item extends z.ZodType>(item: Item, description: string) =>
  z.array(item).default([]).describe(description);

const permissions = {
  events: list(dottedName, "Events the plugin receives."),
  secrets: list(
    secretReference,
    "Secret references the plugin asks the host to resolve.",
  ),
  network: list(host, "Hostnames the plugin connects to."),
};

const contributions = {
  uiSlots: list(dottedName, "UI slots the plugin renders into."),
  secretSchemes: list(
    scheme,
    "Secret reference schemes the plugin resolves as a secret backend.",
  ),
};

export type PermissionKind = keyof typeof permissions;
export type ContributionKind = keyof typeof contributions;

export const pluginManifestSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe(
        "The manifest's JSON Schema, for editors. The host ignores it.",
      ),
    id: id.describe("Unique plugin id."),
    version: version.describe("The plugin's own version."),
    api: apiRange.describe(
      "The plugin-API versions the plugin supports, as an npm semver range.",
    ),
    entry: entry.describe(
      "The module the host starts, relative to the manifest.",
    ),
    permissions: z
      .strictObject(permissions)
      .prefault({})
      .describe("What the plugin needs. The host grants nothing else."),
    contributes: z
      .strictObject(contributions)
      .prefault({})
      .describe("What the plugin adds to Aphelion."),
  })
  .meta({
    title: pluginManifestFile,
    description: "An Aphelion plugin's manifest.",
  });

export type PluginManifest = z.output<typeof pluginManifestSchema>;

export type ManifestIssue = { field?: string; message: string };

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: ManifestIssue[] };

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

function issue(path: Path, message: string): ManifestIssue {
  return path.length === 0 ? { message } : { field: fieldName(path), message };
}

function reason(data: unknown, problem: z.core.$ZodIssue): string {
  switch (problem.code) {
    case "custom":
    case "invalid_format":
      return problem.message;
    case "unrecognized_keys":
      return "has an unknown field";
    case "invalid_type":
      if (problem.path.length === 0) return "must be an object";
      return valueAt(data, problem.path) === undefined
        ? "is required"
        : "has the wrong type";
    default:
      return "is invalid";
  }
}

function schemaIssues(data: unknown, error: z.ZodError): ManifestIssue[] {
  return error.issues.map((problem) =>
    issue(problem.path, reason(data, problem)),
  );
}

export function parsePluginManifest(data: unknown): ManifestResult {
  const parsed = pluginManifestSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, issues: schemaIssues(data, parsed.error) };
  }
  const manifest = parsed.data;
  if (!satisfies(pluginApiVersion, manifest.api)) {
    return {
      ok: false,
      issues: [
        issue(
          ["api"],
          `doesn't include plugin API ${pluginApiVersion}, which this host runs`,
        ),
      ],
    };
  }
  return { ok: true, manifest };
}
