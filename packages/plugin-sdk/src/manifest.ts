import { satisfies, valid, validRange } from "semver";
import { z } from "zod";

/** The plugin API version that this SDK and the host run. A manifest's `api` range must include it. */
export const pluginApiVersion = "0.2.2";

/** The name of the manifest file in a plugin's folder. */
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
  { error: "must be an npm semver range, such as ^0.2.0" },
);

const repository = text(140).regex(
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/,
  {
    error:
      "must be a GitHub repository as owner/name, such as octo-org/weather-plugin",
  },
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

const visible = "\\p{L}\\p{N}\\p{P}\\p{S}";
const visibleOrMark = `${visible}\\p{M}`;

const title = text(64).regex(
  new RegExp(
    `^\\p{M}*[${visible}]([${visibleOrMark} ]*[${visibleOrMark}])?$`,
    "u",
  ),
  {
    error:
      "must be visible text that doesn't start or end with a space, such as Issues and PRs",
  },
);

const iconName = text(64).regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, {
  error: "must be an icon name, such as git-pull-request",
});

const menuOrderRange = "must be from 0 to 999";

const screen = z.strictObject({
  id: id.describe("The screen's id, unique within the plugin."),
  title: title.describe("The screen's name in the app's menu."),
  icon: iconName
    .optional()
    .describe("The icon next to the title, from the app's icon set."),
  menuOrder: z
    .int()
    .min(0, { error: menuOrderRange })
    .max(999, { error: menuOrderRange })
    .optional()
    .describe(
      "Where the screen goes in the menu. Lower numbers come first, and screens without one come last.",
    ),
});

const list = <Item extends z.ZodType>(item: Item, description: string) =>
  z.array(item).default([]).describe(description);

const permissions = {
  events: list(dottedName, "Events the plugin receives."),
  secrets: list(
    secretReference,
    "Secret references the plugin may ask the host to use for it, such as in an HTTP call. The plugin never receives the values.",
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
    "Secret reference schemes the plugin resolves as a secret backend. The values it returns go only to the secrets broker.",
  ),
  screens: list(
    screen,
    "Full pages the plugin's client part draws, each with an entry in the app's menu. They appear when the plugin is installed, with no grant.",
  ),
};

/** The names of the lists in a manifest's `permissions`. */
export type PermissionKind = keyof typeof permissions;
/** The names of the lists in a manifest's `contributes`. */
export type ContributionKind = keyof typeof contributions;

type PluginSide = "server" | "client";

const pluginSides: readonly PluginSide[] = ["server", "client"];

type Sides =
  readonly ["server"] | readonly ["client"] | readonly ["server", "client"];

const sidesFor = {
  permissions: {
    events: ["server", "client"],
    secrets: ["server"],
    network: ["server"],
    uiSlots: ["client"],
  },
  contributes: {
    secretSchemes: ["server"],
    screens: ["client"],
  },
} as const satisfies {
  permissions: Record<PermissionKind, Sides>;
  contributes: Record<ContributionKind, Sides>;
};

type OneSideRule = {
  group: keyof typeof sidesFor;
  kind: string;
  side: PluginSide;
};

const oneSideRules = Object.entries(sidesFor).flatMap(([group, kinds]) =>
  Object.entries(kinds).flatMap(([kind, sides]: [string, Sides]) =>
    sides.length === 1
      ? [{ group: group as OneSideRule["group"], kind, side: sides[0] }]
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

/**
 * The Zod schema for `aphelion-plugin.json`, whose fields [the plugin manifest reference](https://github.com/jcore9/Aphelion/blob/dev/docs/reference/plugin-manifest.md) lists.
 * It fills in empty lists and checks that `api` is a valid version range, but not that the range includes `pluginApiVersion`. `parsePluginManifest` checks both.
 */
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
    repository: repository
      .optional()
      .describe(
        "The GitHub repository, as owner/name, whose releases update the plugin.",
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
      const lists: Record<string, readonly unknown[]> = manifest[group];
      if (lists[kind]?.length && !present.includes(side)) {
        context.issues.push({
          code: "custom",
          path: [group, kind],
          message: `needs a ${side} part`,
          input: lists[kind],
        });
      }
    }
    const seen = new Set<string>();
    manifest.contributes.screens.forEach((screen, index) => {
      if (seen.has(screen.id)) {
        context.issues.push({
          code: "custom",
          path: ["contributes", "screens", index, "id"],
          message: "must be unique within the plugin",
          input: screen.id,
        });
      }
      seen.add(screen.id);
    });
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

type PluginPart = { readonly entry: string };

type ParsedManifest = z.output<typeof pluginManifestSchema>;

type ItemOf<Lists, Kind> = Kind extends keyof Lists
  ? Lists[Kind] extends readonly (infer Item)[]
    ? Item
    : never
  : never;

type ListsFor<
  Group extends keyof typeof sidesFor,
  Present extends PluginSide,
> = {
  readonly [Kind in keyof (typeof sidesFor)[Group]]: [
    Extract<((typeof sidesFor)[Group][Kind] & Sides)[number], Present>,
  ] extends [never]
    ? readonly never[]
    : readonly Readonly<ItemOf<ParsedManifest[Group], Kind>>[];
};

type ManifestWith<Present extends PluginSide> = Readonly<
  Omit<ParsedManifest, PluginSide | "permissions" | "contributes"> & {
    [Side in Present]: PluginPart;
  } & {
    [Side in Exclude<PluginSide, Present>]?: never;
  } & {
    permissions: ListsFor<"permissions", Present>;
    contributes: ListsFor<"contributes", Present>;
  }
>;

/**
 * A manifest that `parsePluginManifest` accepted, read-only and with every list filled in.
 * A list that needs a part the plugin doesn't have is typed as empty, such as `uiSlots` for a plugin with only a server part.
 */
export type PluginManifest =
  ManifestWith<"server"> | ManifestWith<"client"> | ManifestWith<PluginSide>;

/** A full page that a plugin's client part adds to the app's menu, from `contributes.screens`. */
export type PluginScreen = PluginManifest["contributes"]["screens"][number];

/** One problem that `parsePluginManifest` found. */
export type ManifestIssue = {
  /** The field with the problem, such as `permissions.network[0]`. It is missing when the problem is with the whole manifest. */
  field?: string;
  /** What is wrong with the field, such as `is required`. */
  message: string;
};

/** The result of `parsePluginManifest`. It holds the manifest when `ok` is `true`, and the problems when `ok` is `false`. */
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
    case "too_small":
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

/** Checks the parsed JSON of `aphelion-plugin.json`, including its API range. It returns the problems instead of throwing. */
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
