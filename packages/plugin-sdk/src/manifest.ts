import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

export const pluginApiVersion = "0.1.0";

export const pluginManifestFile = "aphelion-plugin.json";

const text = (max: number) =>
  z.string().max(max, {
    error: `must be at most ${String(max)} characters`,
    abort: true,
  });

const id = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, {
  error:
    "must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter",
});

const versionError = "must be a semver version, such as 1.0.0";

const version = text(256)
  .regex(
    /^(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})\.(0|[1-9]\d{0,14})(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(\+[0-9a-zA-Z-]+(\.[0-9a-zA-Z-]+)*)?$/,
    { error: versionError, abort: true },
  )
  .refine((value) => valid(value) !== null, { error: versionError });

const apiRange = text(256).refine(
  (range) =>
    range.split("||").every((part) => part.trim() !== "") &&
    validRange(range) !== null,
  { error: "must be an npm semver range, such as ^0.1.0" },
);

const entry = text(1024).regex(
  /^(\.\/)?((?!\.\.?\/)[\w.@+-]+\/)*(?!\.\.?$)[\w.@+-]+$/,
  {
    error:
      "must be a relative path inside the plugin's folder, such as dist/index.js",
  },
);

const dottedName = text(128).regex(
  /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/,
  { error: "must be words joined by dots, such as approval.requested" },
);

const secretReference = text(1024).regex(
  /^[a-z][a-z0-9+.-]*:\/\/[\p{L}\p{M}\p{N}\p{P}\p{S} ]+$/u,
  {
    error: "must be a secret reference, such as op://vault/item/field",
  },
);

const host = text(253).regex(
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/,
  { error: "must be a lowercase hostname, such as api.github.com" },
);

const scheme = text(32).regex(/^[a-z][a-z0-9+.-]*$/, {
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
  uiSlots: list(
    dottedName,
    "UI slots the plugin shows content in. The owner grants each one, because content there can show what is in a chat.",
  ),
};

const contributions = {
  secretSchemes: list(
    scheme,
    "Secret reference schemes the plugin resolves as a secret backend.",
  ),
};

export type PermissionKind = keyof typeof permissions;
export type ContributionKind = keyof typeof contributions;

type PluginSide = "server" | "client";

const pluginSides: readonly PluginSide[] = ["server", "client"];

const sidesFor = {
  permissions: {
    events: ["server", "client"],
    secrets: ["server"],
    network: ["server"],
    uiSlots: ["client"],
  },
  contributes: {
    secretSchemes: ["server"],
  },
} as const satisfies {
  permissions: Record<PermissionKind, readonly PluginSide[]>;
  contributes: Record<ContributionKind, readonly PluginSide[]>;
};

type OneSideRule = {
  group: keyof typeof sidesFor;
  kind: string;
  side: PluginSide;
};

const oneSideRules = Object.entries(sidesFor).flatMap(([group, kinds]) =>
  Object.entries(kinds).flatMap(
    ([kind, [side, ...others]]: [string, readonly PluginSide[]]) =>
      side && others.length === 0
        ? [{ group: group as OneSideRule["group"], kind, side }]
        : [],
  ),
);

const part = (description: string) =>
  z
    .strictObject({
      entry: entry.describe(
        "The file the host loads, relative to the manifest.",
      ),
    })
    .optional()
    .describe(description);

export const pluginManifestSchema = z
  .strictObject({
    $schema: text(2048)
      .optional()
      .describe(
        "The manifest's JSON Schema, for editors. The host ignores it.",
      ),
    id: id.describe("Unique plugin id."),
    version: version.describe("The plugin's own version."),
    api: apiRange.describe(
      "The plugin-API versions the plugin supports, as an npm semver range.",
    ),
    server: part(
      "The part the plugin runner starts on the server, in its own process.",
    ),
    client: part(
      "The part every client loads from the server and runs in a sandbox.",
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
  .check((context) => {
    const manifest = context.value;
    const present = pluginSides.filter((side) => manifest[side] !== undefined);
    if (present.length === 0) {
      context.issues.push({
        code: "custom",
        path: [],
        message: "must have a server part, a client part, or both",
        input: manifest,
      });
      return;
    }
    for (const { group, kind, side } of oneSideRules) {
      const lists: Record<string, string[]> = manifest[group];
      if (lists[kind]?.length && !present.includes(side)) {
        context.issues.push({
          code: "custom",
          path: [group, kind],
          message: `needs a ${side} part`,
          input: lists[kind],
        });
      }
    }
  })
  .meta({
    title: pluginManifestFile,
    description: "An Aphelion plugin's manifest.",
    anyOf: pluginSides.map((side) => ({ required: [side] })),
    allOf: oneSideRules.map(({ group, kind, side }) => ({
      if: {
        properties: {
          [group]: {
            properties: { [kind]: { minItems: 1 } },
            required: [kind],
          },
        },
        required: [group],
      },
      then: { required: [side] },
    })),
  });

type PluginPart = { entry: string };

type ListsFor<
  Kinds extends Record<string, readonly PluginSide[]>,
  Present extends PluginSide,
> = {
  [Kind in keyof Kinds]: [Extract<Kinds[Kind][number], Present>] extends [never]
    ? never[]
    : string[];
};

type ManifestWith<Present extends PluginSide> = Omit<
  z.output<typeof pluginManifestSchema>,
  PluginSide | "permissions" | "contributes"
> & { [Side in Present]: PluginPart } & {
  [Side in Exclude<PluginSide, Present>]?: never;
} & {
  permissions: ListsFor<(typeof sidesFor)["permissions"], Present>;
  contributes: ListsFor<(typeof sidesFor)["contributes"], Present>;
};

export type PluginManifest =
  ManifestWith<"server"> | ManifestWith<"client"> | ManifestWith<PluginSide>;

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
    case "too_big":
      return `must be at most ${String(problem.maximum)} characters`;
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
  const manifest = parsed.data as PluginManifest;
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
