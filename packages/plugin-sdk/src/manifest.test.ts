import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  parsePluginManifest,
  pluginApiVersion,
  pluginManifestSchema,
  type PluginManifest,
} from "./manifest.ts";

const identity = {
  id: "weather",
  version: "1.0.0",
  api: `^${pluginApiVersion}`,
};

const minimal = { ...identity, server: { entry: "dist/index.js" } };

const clientOnly = { ...identity, client: { entry: "dist/client.js" } };

const full = {
  ...minimal,
  $schema: "./node_modules/@aphelion/plugin-sdk/plugin-manifest.schema.json",
  client: { entry: "dist/client.js" },
  permissions: {
    events: ["approval.requested"],
    secrets: ["op://AI Agents/Weather/api-key"],
    network: ["api.weather.example"],
    uiSlots: ["agent.sidebar"],
  },
  contributes: {
    secretSchemes: ["op"],
  },
};

const entryCases = {
  accepted: [
    "index.ts",
    "./dist/index.js",
    "dist/..hidden/index.js",
    "dist/index.min.js",
    "lib/@scope_name+x-1/main.mjs",
  ],
  refused: [
    "/opt/plugin/index.js",
    "../index.js",
    "dist/../../x.js",
    "./../x.js",
    "dist\\index.js",
    "file:///dir/index.js",
    "https://example.com/index.js",
    "C:/dir/index.js",
    "C:index.js",
    "//server/share/index.js",
    "dist/\u0000index.js",
    "dist/\tindex.js",
    "dist/\u007findex.js",
    "dist//index.js",
    "dist/",
    ".",
    "./",
    "dist/.",
    "",
  ],
};

const versionCases = {
  accepted: [
    "1.0.0",
    "0.1.0-beta.2",
    "2.3.4+build.5",
    "1.0.0-0",
    "1.0.0-0a.1",
    "1.0.0-rc.1+001",
    "999999999999999.0.0",
  ],
  refused: [
    "1.0",
    "v1.0.0",
    "01.0.0",
    "latest",
    "1.0.0-01",
    "1.0.0-rc.01",
    "1.0.0-",
    "1.0.0+",
    "9007199254740992.0.0",
    "1000000000000000.0.0",
    "0.9007199254740992.0",
  ],
};

const secretCases = {
  accepted: [
    "op://AI Agents/Wetter Zürich/credential",
    "bws://3f2a/api-key",
    "op://vault/\u{1F511} key/field",
    "op://vault/cafe\u0301/field",
  ],
  refused: [
    ["Cc", "op://vault/item\nfield"],
    ["Cc", "op://vault/item\u0000"],
    ["Cc", "op://vault/item\u007f"],
    ["Cc", "op://vault/item\u0085"],
    ["Cf", "op://vault/\u202eitem"],
    ["Cf", "op://vault/it\u200bem"],
    ["Zl", "op://vault/item\u2028"],
    ["Zp", "op://vault/item\u2029"],
    ["Zs", "op://vault/item\u00a0x"],
    ["Zs", "op://vault/item\u3000x"],
    ["Cs", "op://vault/item\ud800"],
    ["Co", "op://vault/item\ue000"],
    ["Cn", "op://vault/item\uffff"],
  ].map(([, reference]) => reference ?? ""),
};

function issuesOf(data: unknown) {
  const result = parsePluginManifest(data);
  if (result.ok) throw new Error("expected the manifest to be refused");
  return result.issues;
}

describe("parsePluginManifest", () => {
  test("accepts a minimal manifest and defaults every list to empty", () => {
    expect(parsePluginManifest(minimal)).toEqual({
      ok: true,
      manifest: {
        ...minimal,
        permissions: { events: [], secrets: [], network: [], uiSlots: [] },
        contributes: { secretSchemes: [] },
      },
    });
  });

  test("accepts a manifest that declares every permission and contribution", () => {
    expect(parsePluginManifest(full)).toEqual({ ok: true, manifest: full });
  });

  test("names each missing field", () => {
    expect(issuesOf({ id: "weather" })).toEqual([
      { field: "version", message: "is required" },
      { field: "api", message: "is required" },
    ]);
  });

  test.each([
    ["a server part", minimal],
    ["a client part", clientOnly],
    ["both parts", full],
  ])("accepts a plugin with %s", (_parts, manifest) => {
    expect(parsePluginManifest(manifest).ok).toBe(true);
  });

  test("refuses a plugin with neither part", () => {
    expect(issuesOf(identity)).toEqual([
      { message: "must have a server part, a client part, or both" },
    ]);
  });

  test.each(["server", "client"])("needs an entry in the %s part", (side) => {
    expect(issuesOf({ ...identity, [side]: {} })).toEqual([
      { field: `${side}.entry`, message: "is required" },
    ]);
  });

  test("refuses the single entry field that parts replaced", () => {
    expect(issuesOf({ ...minimal, entry: "dist/index.js" })).toEqual([
      { message: "has an unknown field" },
    ]);
  });

  test("reports an unknown field by the object that holds it, without echoing its name", () => {
    expect(
      issuesOf({ ...minimal, "<script>": "x", permissions: { evnts: [] } }),
    ).toEqual([
      { field: "permissions", message: "has an unknown field" },
      { message: "has an unknown field" },
    ]);
  });

  test("treats UI slots as a permission, not a contribution", () => {
    expect(
      issuesOf({ ...minimal, contributes: { uiSlots: ["agent.sidebar"] } }),
    ).toEqual([{ field: "contributes", message: "has an unknown field" }]);
  });

  test("names a field with the wrong type", () => {
    expect(issuesOf({ ...minimal, permissions: { events: "x" } })).toEqual([
      { field: "permissions.events", message: "has the wrong type" },
    ]);
  });

  test("names the list item that is invalid", () => {
    expect(
      issuesOf({
        ...minimal,
        permissions: {
          events: ["approval.requested", "Approval"],
          secrets: ["op:/vault/item"],
          network: ["https://api.github.com"],
        },
        contributes: { secretSchemes: ["op://"] },
      }),
    ).toEqual([
      {
        field: "permissions.events[1]",
        message: "must be words joined by dots, such as approval.requested",
      },
      {
        field: "permissions.secrets[0]",
        message: "must be a secret reference, such as op://vault/item/field",
      },
      {
        field: "permissions.network[0]",
        message: "must be a lowercase hostname, such as api.github.com",
      },
      {
        field: "contributes.secretSchemes[0]",
        message: "must be a reference scheme without ://, such as op",
      },
    ]);
  });

  test.each(secretCases.accepted)(
    "accepts the secret reference %j",
    (reference) => {
      expect(
        parsePluginManifest({
          ...minimal,
          permissions: { secrets: [reference] },
        }).ok,
      ).toBe(true);
    },
  );

  test.each(secretCases.refused)(
    "refuses the secret reference %j",
    (reference) => {
      expect(
        issuesOf({ ...minimal, permissions: { secrets: [reference] } }),
      ).toEqual([
        {
          field: "permissions.secrets[0]",
          message: "must be a secret reference, such as op://vault/item/field",
        },
      ]);
    },
  );

  test("refuses a manifest that is not an object", () => {
    expect(issuesOf([])).toEqual([{ message: "must be an object" }]);
  });

  test.each(["Weather", "1weather", "weather_bot", ""])(
    "refuses the id %j",
    (id) => {
      expect(issuesOf({ ...minimal, id })).toEqual([
        {
          field: "id",
          message:
            "must be 1 to 63 lowercase letters, digits or hyphens, starting with a letter",
        },
      ]);
    },
  );

  test.each(versionCases.accepted)("accepts the version %j", (version) => {
    expect(parsePluginManifest({ ...minimal, version }).ok).toBe(true);
  });

  test.each(versionCases.refused)("refuses the version %j", (version) => {
    expect(issuesOf({ ...minimal, version })).toEqual([
      {
        field: "version",
        message: "must be a semver version, such as 1.0.0",
      },
    ]);
  });

  describe.each(["server", "client"])("the %s entry", (side) => {
    test.each(entryCases.accepted)("accepts %j", (entry) => {
      expect(parsePluginManifest({ ...identity, [side]: { entry } }).ok).toBe(
        true,
      );
    });

    test.each(entryCases.refused)("refuses %j", (entry) => {
      expect(issuesOf({ ...identity, [side]: { entry } })).toEqual([
        {
          field: `${side}.entry`,
          message:
            "must be a relative path inside the plugin's folder, such as dist/index.js",
        },
      ]);
    });
  });
});

describe("permissions and contributions by side", () => {
  const serverOnly: [string, unknown][] = [
    ["permissions.secrets", { permissions: { secrets: ["op://v/i/f"] } }],
    ["permissions.network", { permissions: { network: ["api.github.com"] } }],
    ["contributes.secretSchemes", { contributes: { secretSchemes: ["op"] } }],
  ];
  const clientOnlyLists: [string, unknown][] = [
    ["permissions.uiSlots", { permissions: { uiSlots: ["agent.sidebar"] } }],
  ];
  const either = { permissions: { events: ["agent.status"] } };

  test.each(serverOnly)("refuses %s without a server part", (field, lists) => {
    expect(issuesOf({ ...clientOnly, ...(lists as object) })).toEqual([
      { field, message: "needs a server part" },
    ]);
  });

  test.each(serverOnly)("accepts %s with a server part", (_field, lists) => {
    expect(parsePluginManifest({ ...minimal, ...(lists as object) }).ok).toBe(
      true,
    );
  });

  test.each(clientOnlyLists)(
    "refuses %s without a client part",
    (field, lists) => {
      expect(issuesOf({ ...minimal, ...(lists as object) })).toEqual([
        { field, message: "needs a client part" },
      ]);
    },
  );

  test.each(clientOnlyLists)(
    "accepts %s with a client part",
    (_field, lists) => {
      expect(
        parsePluginManifest({ ...clientOnly, ...(lists as object) }).ok,
      ).toBe(true);
    },
  );

  test.each([minimal, clientOnly])(
    "accepts events with either part",
    (manifest) => {
      expect(parsePluginManifest({ ...manifest, ...either }).ok).toBe(true);
    },
  );

  test("accepts an empty list on the side that can't use it", () => {
    expect(
      parsePluginManifest({
        ...clientOnly,
        permissions: { secrets: [], network: [] },
        contributes: { secretSchemes: [] },
      }).ok,
    ).toBe(true);
  });

  test("names every list that needs a missing part", () => {
    expect(
      issuesOf({
        ...clientOnly,
        permissions: { secrets: ["op://v/i/f"], network: ["api.github.com"] },
        contributes: { secretSchemes: ["op"] },
      }),
    ).toEqual([
      { field: "permissions.secrets", message: "needs a server part" },
      { field: "permissions.network", message: "needs a server part" },
      { field: "contributes.secretSchemes", message: "needs a server part" },
    ]);
  });

  test("the manifest type has no variant without a part, or with secrets on a client part", () => {
    const lists = { events: [], secrets: [], network: [], uiSlots: [] };
    const base = { ...identity, contributes: { secretSchemes: [] } };
    const valid: PluginManifest[] = [
      { ...base, server: minimal.server, permissions: lists },
      { ...base, client: clientOnly.client, permissions: lists },
    ];
    // @ts-expect-error a manifest needs a server part, a client part, or both
    const neither: PluginManifest = { ...base, permissions: lists };
    // @ts-expect-error only a server part can hold secrets
    const secretsOnClient: PluginManifest = {
      ...base,
      client: clientOnly.client,
      permissions: { ...lists, secrets: ["op://v/i/f"] },
    };
    expect([...valid, neither, secretsOnClient]).toHaveLength(4);
  });
});

describe("the API-range check", () => {
  test.each([
    `^${pluginApiVersion}`,
    `~${pluginApiVersion}`,
    pluginApiVersion,
    `>=${pluginApiVersion} <1.0.0`,
    `^9.0.0 || ^${pluginApiVersion}`,
    "*",
  ])("accepts a plugin whose range %j includes this host", (api) => {
    expect(parsePluginManifest({ ...minimal, api }).ok).toBe(true);
  });

  test.each([`>${pluginApiVersion}`, "^1.0.0", `<${pluginApiVersion}`])(
    "refuses a plugin whose range %j leaves this host out",
    (api) => {
      expect(issuesOf({ ...minimal, api })).toEqual([
        {
          field: "api",
          message: `doesn't include plugin API ${pluginApiVersion}, which this host runs`,
        },
      ]);
    },
  );

  test.each(["banana", "latest", "^", ">>0.1.0", "", " ", "^0.1.0 ||"])(
    "refuses the malformed range %j",
    (api) => {
      expect(issuesOf({ ...minimal, api })).toEqual([
        {
          field: "api",
          message: "must be an npm semver range, such as ^0.1.0",
        },
      ]);
    },
  );
});

describe("length limits", () => {
  const long = (length: number) => "a".repeat(length);
  const cases: [string, number, (text: string) => unknown][] = [
    ["api", 256, (api) => ({ ...minimal, api: `^${pluginApiVersion} ${api}` })],
    ["version", 256, (text) => ({ ...minimal, version: `1.0.0-${text}` })],
    [
      "server.entry",
      1024,
      (text) => ({ ...identity, server: { entry: `${text}.js` } }),
    ],
    [
      "client.entry",
      1024,
      (text) => ({ ...identity, client: { entry: `${text}.js` } }),
    ],
    ["$schema", 2048, (text) => ({ ...minimal, $schema: text })],
    [
      "permissions.events[0]",
      128,
      (text) => ({ ...minimal, permissions: { events: [`a.${text}`] } }),
    ],
    [
      "permissions.secrets[0]",
      1024,
      (text) => ({ ...minimal, permissions: { secrets: [`op://${text}`] } }),
    ],
    [
      "permissions.network[0]",
      253,
      (text) => ({ ...minimal, permissions: { network: [text] } }),
    ],
    [
      "permissions.uiSlots[0]",
      128,
      (text) => ({ ...minimal, permissions: { uiSlots: [`a.${text}`] } }),
    ],
    [
      "contributes.secretSchemes[0]",
      32,
      (text) => ({ ...minimal, contributes: { secretSchemes: [text] } }),
    ],
  ];

  test.each(cases)(
    "refuses %s over %i characters with one fixed reason, before any other check",
    (field, max, build) => {
      expect(issuesOf(build(long(max + 1)))).toEqual([
        { field, message: `must be at most ${String(max)} characters` },
      ]);
    },
  );
});

function jsonSchema() {
  return z.toJSONSchema(pluginManifestSchema, {
    target: "draft-7",
    io: "input",
  });
}

type JsonSchema = {
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

test.each([
  [
    "server.entry",
    entryCases,
    (schema: JsonSchema) =>
      schema.properties?.["server"]?.properties?.["entry"],
  ],
  [
    "client.entry",
    entryCases,
    (schema: JsonSchema) =>
      schema.properties?.["client"]?.properties?.["entry"],
  ],
  [
    "version",
    versionCases,
    (schema: JsonSchema) => schema.properties?.["version"],
  ],
  [
    "permissions.secrets",
    secretCases,
    (schema: JsonSchema) =>
      schema.properties?.["permissions"]?.properties?.["secrets"]?.items,
  ],
] as const)(
  "the JSON Schema pattern for %s agrees with the parser",
  (_field, cases, select) => {
    const pattern = new RegExp(
      select(jsonSchema() as JsonSchema)?.pattern ?? "",
      "u",
    );
    expect(cases.accepted.filter((value) => !pattern.test(value))).toEqual([]);
    expect(cases.refused.filter((value) => pattern.test(value))).toEqual([]);
  },
);

test("plugin-manifest.schema.json matches the schema", async () => {
  const schema = jsonSchema();
  await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
    "../plugin-manifest.schema.json",
  );
});
