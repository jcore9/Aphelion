import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  parsePluginManifest,
  pluginApiVersion,
  pluginManifestSchema,
} from "./manifest.ts";

const minimal = {
  id: "weather",
  version: "1.0.0",
  api: `^${pluginApiVersion}`,
  entry: "dist/index.js",
};

const full = {
  ...minimal,
  $schema: "./node_modules/@aphelion/plugin-sdk/plugin-manifest.schema.json",
  permissions: {
    events: ["approval.requested"],
    secrets: ["op://AI Agents/Weather/api-key"],
    network: ["api.weather.example"],
  },
  contributes: {
    uiSlots: ["agent.sidebar"],
    secretSchemes: ["op"],
  },
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
        permissions: { events: [], secrets: [], network: [] },
        contributes: { uiSlots: [], secretSchemes: [] },
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
      { field: "entry", message: "is required" },
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

  test.each(["1.0.0", "0.1.0-beta.2", "2.3.4+build.5"])(
    "accepts the version %j",
    (version) => {
      expect(parsePluginManifest({ ...minimal, version }).ok).toBe(true);
    },
  );

  test.each(["1.0", "v1.0.0", "01.0.0", "latest"])(
    "refuses the version %j",
    (version) => {
      expect(issuesOf({ ...minimal, version })).toEqual([
        {
          field: "version",
          message: "must be a semver version, such as 1.0.0",
        },
      ]);
    },
  );

  test.each(["index.ts", "./dist/index.js", "dist/..hidden/index.js"])(
    "accepts the entry %j",
    (entry) => {
      expect(parsePluginManifest({ ...minimal, entry }).ok).toBe(true);
    },
  );

  test.each([
    "/opt/plugin/index.js",
    "../index.js",
    "dist/../../x.js",
    "dist\\index.js",
    "",
  ])("refuses the entry %j", (entry) => {
    expect(issuesOf({ ...minimal, entry })).toEqual([
      {
        field: "entry",
        message:
          "must be a relative path inside the plugin's folder, such as dist/index.js",
      },
    ]);
  });
});

describe("the API-range check", () => {
  test.each([
    `^${pluginApiVersion}`,
    `~${pluginApiVersion}`,
    pluginApiVersion,
    `>=${pluginApiVersion} <1.0.0`,
    `^9.0.0 || ^${pluginApiVersion}`,
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

test("plugin-manifest.schema.json matches the schema", async () => {
  const schema = z.toJSONSchema(pluginManifestSchema, {
    target: "draft-7",
    io: "input",
  });
  await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
    "../plugin-manifest.schema.json",
  );
});
