import { expect, test } from "vitest";
import sdkPackage from "../../packages/plugin-sdk/package.json" with { type: "json" };
import { pluginApiVersion } from "../../packages/plugin-sdk/src/manifest";
import { collectPluginApi, renderPluginApi } from "./plugin-api";

const reference = collectPluginApi();

const specifiers = (extension: string) =>
  Object.entries(sdkPackage.exports)
    .filter(([, target]) => target.endsWith(extension))
    .map(([key]) =>
      key === "." ? sdkPackage.name : `${sdkPackage.name}/${key.slice(2)}`,
    );

test("docs/reference/plugin-api.md matches the plugin SDK", async () => {
  await expect(await renderPluginApi(reference)).toMatchFileSnapshot(
    "../reference/plugin-api.md",
  );
});

test("every export and every member has a description", () => {
  const missing = reference.entries.flatMap(({ specifier, exports }) =>
    exports.flatMap((item) => [
      ...(item.description ? [] : [`${specifier} ${item.name}`]),
      ...item.members
        .filter(({ description }) => !description)
        .map(({ name }) => `${specifier} ${item.name}.${name}`),
    ]),
  );
  expect(missing).toEqual([]);
});

test("every entry point and file in package.json is on the page", () => {
  expect(reference.entries.map(({ specifier }) => specifier)).toEqual(
    specifiers(".ts"),
  );
  expect(reference.assets.map(({ specifier }) => specifier)).toEqual(
    specifiers(".json"),
  );
});

test("the page states the SDK's plugin API version", () => {
  expect(reference.apiVersion).toBe(pluginApiVersion);
});
