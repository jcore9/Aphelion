# Plugin manifest

Every plugin has one manifest, a JSON file named `aphelion-plugin.json` in the plugin's folder, next to its `package.json`. The manifest says who the plugin is, which version of the plugin API it was written for, what it needs and what it adds. The host reads the plugin's permissions from the manifest and from nowhere else. There is no other registration step ([decision 0038](../decisions/0038-plugin-manifest-and-api-range.md)).

`@aphelion/plugin-sdk` exports the schema as `pluginManifestSchema` and the check as `parsePluginManifest`.

## Example

This manifest is for a made-up plugin that posts weather alerts. A test loads it, so it stays valid.

```json
{
  "$schema": "./node_modules/@aphelion/plugin-sdk/plugin-manifest.schema.json",
  "id": "weather-alerts",
  "version": "1.2.0",
  "api": "^0.1.0",
  "entry": "dist/index.js",
  "permissions": {
    "events": ["approval.requested"],
    "secrets": ["op://AI Agents/Weather API/credential"],
    "network": ["api.weather.example"]
  },
  "contributes": {
    "uiSlots": ["agent.sidebar"]
  }
}
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | string | no | The manifest's JSON Schema, for editors. The host ignores it. |
| `id` | string | yes | Unique plugin id. 1 to 63 lowercase letters, digits or hyphens, starting with a letter. |
| `version` | string | yes | The plugin's own version, in [semver](https://semver.org/) form, such as `1.2.0`. |
| `api` | string | yes | The plugin-API versions the plugin supports, as an npm semver range. See [The API range](#the-api-range). |
| `entry` | string | yes | The module the host starts, as a path relative to the manifest, such as `dist/index.js`. It can't start with `/`, contain `\`, or have a `..` part. |
| `permissions.events` | list of strings | no | Events the plugin receives. Each is words joined by dots, such as `approval.requested`. |
| `permissions.secrets` | list of strings | no | Secret references the plugin asks the host to resolve, such as `op://vault/item/field`. The plugin never reads a secret store itself. |
| `permissions.network` | list of strings | no | Lowercase hostnames the plugin connects to, such as `api.github.com`. No scheme, port or path. |
| `contributes.uiSlots` | list of strings | no | UI slots the plugin renders into. Each is words joined by dots, such as `agent.sidebar`. |
| `contributes.secretSchemes` | list of strings | no | Secret reference schemes the plugin resolves as a secret backend, such as `op`. See [Secret backends](#secret-backends). |

`permissions` and `contributes` can be left out, and so can each list in them. A missing list is empty, so the plugin gets nothing it didn't ask for. Any field not in this table is an error.

The manifest has no format version of its own. The `api` range covers it, because the manifest's format is part of the plugin API.

What the host does with each permission, such as asking the owner to grant it, is the plugin host's job (M0-13c). The manifest only declares it. Event names and UI slots aren't checked against a list yet, because the protocol and the client haven't defined them.

## The API range

The plugin API has its own [semver](https://semver.org/) version, `pluginApiVersion` in `@aphelion/plugin-sdk`. It is `0.1.0` today. The version changes like this:

- A change that could break a plugin raises the major version. Before 1.0.0, it raises the minor version instead, so 0.1.x to 0.2.0 is a breaking change.
- A change that adds to the API raises the minor version, or the patch version before 1.0.0.

A plugin's `api` field says which versions it supports, using the range syntax from [npm's semver documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#dependencies), the same syntax as `dependencies` in `package.json`. Write `^0.1.0` to accept 0.1.0 and any later 0.1.x.

When the host loads a plugin, it checks its own `pluginApiVersion` against the plugin's `api` range:

- If the range includes the host's version, the plugin loads.
- If it doesn't, the host refuses the plugin with `api: doesn't include plugin API 0.1.0, which this host runs`.
- If the range isn't valid semver range syntax, the manifest is invalid, with `api: must be an npm semver range, such as ^0.1.0`. A range that is blank, or has a blank part between `||` signs, counts as invalid, because npm would read the blank as "any version".

## Secret backends

A secret backend is a plugin that turns a secret reference, such as `op://vault/item/field`, into the secret's value. The 1Password plugin (M0-15) is the first. A backend does two things:

1. It lists the schemes it handles in `contributes.secretSchemes`. A scheme is the part before `://`, such as `op`.
2. It implements the `SecretBackend` type from `@aphelion/plugin-sdk`:

   ```ts
   type SecretReference = `${string}://${string}`;

   type SecretBackend = {
   	resolve(reference: SecretReference): Promise<string>;
   };
   ```

   `resolve` returns the value as a string, or throws if it can't. The secrets broker (M0-14) sends a backend only references with a scheme the backend listed. How the plugin hands its backend to the host is the plugin runner's job (M0-13b).

## Errors

`parsePluginManifest` returns `{ ok: true, manifest }`, or `{ ok: false, issues }`. Each issue names the field by its path, such as `permissions.events[1]`, and gives a fixed reason. A reason never repeats text from the manifest, so a hostile manifest can't put its own text into the host's logs. For the same reason, an unknown field is reported by the object that holds it, not by its name.

| Cause | Field | Reason |
| --- | --- | --- |
| The file isn't a JSON object | none | `must be an object` |
| A required field is missing | `version` | `is required` |
| A field Aphelion doesn't know | `permissions`, or none at the top level | `has an unknown field` |
| A field of the wrong type | `permissions.events` | `has the wrong type` |
| A bad value | `permissions.network[0]` | `must be a lowercase hostname, such as api.github.com` |
| An out-of-range plugin | `api` | `doesn't include plugin API 0.1.0, which this host runs` |

## JSON Schema for editors

[`plugin-manifest.schema.json`](https://github.com/jcore9/Aphelion/blob/dev/packages/plugin-sdk/plugin-manifest.schema.json) ships in `@aphelion/plugin-sdk`. Point the manifest's `$schema` field at it, as in the example, and editors such as VS Code check the manifest as you type. The JSON Schema can't express the API-range rule, so only `parsePluginManifest` checks `api`. A test regenerates the file from the schema and fails when the committed copy is out of date. To regenerate it, run `bun --bun vitest run -u packages/plugin-sdk`.
