# Plugin manifest

Every plugin has one manifest, a JSON file named `aphelion-plugin.json` in the plugin's folder, next to its `package.json`. The manifest says who the plugin is, which version of the plugin API it was written for, which parts it has, what it needs and what it adds. The host reads the plugin's permissions from the manifest and from nowhere else. There is no other registration step ([decision 0038](../decisions/0038-plugin-manifest-and-api-range.md)).

`@aphelion/plugin-sdk` exports the schema as `pluginManifestSchema` and the check as `parsePluginManifest`.

## Example

This manifest is for a made-up plugin that posts weather alerts. Its server part reads a weather service with an API key, and its client part shows the alerts in the agent sidebar. A test loads it, so it stays valid.

```json
{
  "$schema": "./node_modules/@aphelion/plugin-sdk/plugin-manifest.schema.json",
  "id": "weather-alerts",
  "version": "1.2.0",
  "api": "^0.2.0",
  "server": { "entry": "dist/server.js" },
  "client": { "entry": "dist/client.js" },
  "permissions": {
    "events": ["approval.requested"],
    "secrets": ["op://AI Agents/Weather API/credential"],
    "network": ["api.weather.example"],
    "uiSlots": ["agent.sidebar"]
  }
}
```

## Fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `$schema` | string | no | The manifest's JSON Schema, for editors. The host ignores it. At most 2048 characters. |
| `id` | string | yes | Unique plugin id. 1 to 63 lowercase letters, digits or hyphens, starting with a letter. |
| `version` | string | yes | The plugin's own version, in strict [semver](https://semver.org/) form, such as `1.2.0` or `2.0.0-rc.1`. No `v` prefix, and no leading zeros in a number, so `1.0.0-rc.01` is refused. Each of the first three numbers has at most 15 digits. At most 256 characters. |
| `api` | string | yes | The plugin-API versions the plugin supports, as an npm semver range. At most 256 characters. See [The API range](#the-api-range). |
| `server` | object | at least one of `server` and `client` | The plugin's server part. The plugin runner starts it on the server, in its own process. See [Server and client parts](#server-and-client-parts). |
| `server.entry` | string | yes, in `server` | The file the plugin runner starts, as a plain relative path inside the plugin's folder, such as `dist/server.js`. See [The entry path](#the-entry-path). At most 1024 characters. |
| `client` | object | at least one of `server` and `client` | The plugin's client part. Every client downloads it from the server and runs it in a sandbox. See [Server and client parts](#server-and-client-parts). |
| `client.entry` | string | yes, in `client` | The file the client loads in the sandbox, with the same rules as `server.entry`, such as `dist/client.js`. |
| `permissions.events` | list of strings | no | Events the plugin receives, in either part. Each is words joined by dots, such as `approval.requested`, at most 128 characters. |
| `permissions.secrets` | list of strings | no | Secret references the plugin may ask the host to use for it, such as `op://vault/item/field`, at most 1024 characters. The host uses the secret in an operation for the plugin, such as an HTTP call, and the plugin never receives the value. See [Secrets](#secrets). Needs a server part. After `://`, a reference may hold letters in any script, accents, digits, punctuation, symbols such as emoji, and the ordinary space. Invisible characters, such as control, format, zero-width and direction characters, line and paragraph separators, and every other kind of space, are refused. The plugin never reads a secret store itself. |
| `permissions.network` | list of strings | no | Lowercase hostnames the plugin connects to, such as `api.github.com`, at most 253 characters. No scheme, port or path. Needs a server part. |
| `permissions.uiSlots` | list of strings | no | UI slots the plugin shows content in. Each is words joined by dots, such as `agent.sidebar`, at most 128 characters. Needs a client part. |
| `contributes.secretSchemes` | list of strings | no | Secret reference schemes the plugin resolves as a secret backend, such as `op`, at most 32 characters. The values it returns go only to the secrets broker. Needs a server part. See [Secret backends](#secret-backends). |

`permissions` and `contributes` can be left out, and so can each list in them. A missing list is empty, so the plugin gets nothing it didn't ask for. Any field not in this table is an error.

The manifest has no format version of its own. The `api` range covers it, because the manifest's format is part of the plugin API.

Each entry under `permissions` is something the owner grants. UI slots are on that list, not under `contributes`, because content shown inside the chat can reveal what is in the chat ([decision 0038](../decisions/0038-plugin-manifest-and-api-range.md)). A secret scheme is a contribution: it says what the plugin offers, and grants nothing to the plugin.

What the host does with each permission, such as asking the owner to grant it, is the plugin host's job (M0-13c). The manifest only declares it. Event names and UI slots aren't checked against a list yet, because the protocol and the client haven't defined them.

The `id` names the plugin's data folder on the server. Windows reserves some file names, such as `con`, `nul` and `com1`. Aphelion runs on Linux only ([decision 0011](../decisions/0011-ubuntu-lts.md)), so those ids are allowed. A future Windows host would have to refuse them.

## Server and client parts

A plugin has a server part, a client part, or both ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)). A manifest with neither is refused.

- The **server part** runs on the server. The plugin runner (M0-13b) starts it in its own process, as the `aphelion-plugins` user.
- The **client part** runs in the app: the web app, the desktop app and the future phone app. It is installed once, on the server, and every client downloads it from the server when it connects. Nothing is installed on a device. It always runs in a sandbox, an isolated frame (an iframe on web and desktop, a WebView on the phone) that talks to the app only through messages. It never runs with full access to the app.

Some permissions and contributions only make sense for one part. A list that needs a part the plugin doesn't have is refused, with the reason `needs a server part` or `needs a client part`. An empty list is allowed on either side.

| List | Needs | Why |
| --- | --- | --- |
| `permissions.events` | either part | Either part can react to events. The server part gets them from the plugin host, and the client part through the app's messages. |
| `permissions.secrets` | a server part | The host uses each secret on the server, for the server part. No part ever receives a value, so none can reach a device. |
| `permissions.network` | a server part | A client part has no network access. It talks only to the app. Internet access, including to MCP servers, goes through the server part and the approval layer. |
| `permissions.uiSlots` | a client part | Only a client part can show anything in the app. |
| `contributes.secretSchemes` | a server part | Secret backends run on the server, next to the secrets broker. |

Each permission is granted to the plugin as a whole. When a plugin has both parts, events it is granted can go to either part.

The `PluginManifest` type describes a manifest that `parsePluginManifest` accepted. It has three shapes: server only, client only, or both. A list the plugin's parts can't use has the type `readonly never[]`, which is always empty, and every list is read-only. `pluginManifestSchema` on its own returns a looser type, so read manifests through `parsePluginManifest`.

## Secrets

A plugin never receives a secret's value. `permissions.secrets` lists the secrets a plugin may ask the host to use for it. For example, the plugin asks "make this HTTP call with my GitHub token", and the host makes the call with the token in it. The value stays inside the host and the secrets broker, in the `Secret` wrapper that is never serialized, so the plugin has nothing it could send to a device. The operations a plugin can ask for are designed in the plugin runner (M0-13b), the permission grants (M0-13c) and the M3 connector gateway ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

The one exception is a [secret backend](#secret-backends). It produces values, so it sees the values it produces. It hands them only to the secrets broker, never to another plugin or a client part.

## The entry path

`server.entry` and `client.entry` follow the same rules. Each must be a plain relative path inside the plugin's folder:

- One or more parts joined by `/`. A part has only letters, digits and the characters `_`, `.`, `@`, `+` and `-`.
- It may start with `./`. No part may be `.` or `..`, and no part may be empty, so `dist//index.js` and `dist/` are refused.
- No URL or other scheme, such as `file://`. No absolute path, such as `/opt/x.js`, `C:/x.js` or `//server/share/x.js`. No `\`, no NUL and no other control characters.

This check reads the text only. When the server loads or serves a part, it must still check that the resolved file is inside the plugin's folder, including after it follows symbolic links. The plugin runner (M0-13b) does this for the server part, and the M5 client-part delivery does it for the client part.

## The API range

The plugin API has its own [semver](https://semver.org/) version, `pluginApiVersion` in `@aphelion/plugin-sdk`. It is `0.2.0` today. [Changes](#changes) lists what changed in each version. The version changes like this:

- A change that could break a plugin raises the major version. Before 1.0.0, it raises the minor version instead, so 0.1.x to 0.2.0 is a breaking change.
- A change that adds to the API raises the minor version, or the patch version before 1.0.0.

A plugin's `api` field says which versions it supports, using the range syntax from [npm's semver documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#dependencies), the same syntax as `dependencies` in `package.json`. Write `^0.2.0` to accept 0.2.0 and any later 0.2.x.

When the host loads a plugin, it checks its own `pluginApiVersion` against the plugin's `api` range:

- If the range includes the host's version, the plugin loads. The range `*` includes every version. It skips the compatibility check, so a plugin that uses it may break without warning when Aphelion upgrades the plugin API. Prefer a range such as `^0.2.0`.
- If it doesn't, the host refuses the plugin with `api: doesn't include plugin API 0.2.0, which this host runs`.
- If the range is longer than 256 characters, the manifest is invalid, with `api: must be at most 256 characters`. The parser checks the length first, and never hands a longer range to `semver`.
- If the range isn't valid semver range syntax, the manifest is invalid, with `api: must be an npm semver range, such as ^0.2.0`. A range that is blank, or has a blank part between `||` signs, counts as invalid, because npm would read the blank as "any version".

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

   `resolve` returns the value as a string, or throws if it can't. The secrets broker (M0-14) sends a backend only references with a scheme the backend listed, and the value goes only to the broker. How the plugin hands its backend to the host is the plugin runner's job (M0-13b).

## Errors

`parsePluginManifest` returns `{ ok: true, manifest }`, or `{ ok: false, issues }`. Each issue names the field by its path, such as `permissions.events[1]`, and gives a fixed reason. A reason never repeats text from the manifest, so a hostile manifest can't put its own text into the host's logs. For the same reason, an unknown field is reported by the object that holds it, not by its name.

The returned issues never repeat manifest text. One exception sits outside them: when the environment variable `NODE_DEBUG` includes `semver`, the `semver` package prints each range it reads to standard error. The host must not set `NODE_DEBUG=semver`.

## Checks the plugin runner adds

The parser checks a value already read from JSON. The plugin runner (M0-13b) owns two more checks:

- Before parsing, it caps the size of `aphelion-plugin.json` in bytes, so a huge file is refused before `JSON.parse` reads it.
- After parsing, it checks that `server.entry` resolves to a file inside the plugin's folder, as [the entry path](#the-entry-path) section says.

| Cause | Field | Reason |
| --- | --- | --- |
| The file isn't a JSON object | none | `must be an object` |
| A required field is missing | `version` | `is required` |
| Neither a server part nor a client part | none | `must have a server part, a client part, or both` |
| A list that needs a part the plugin doesn't have | `permissions.secrets` | `needs a server part` |
| A field Aphelion doesn't know | `permissions`, or none at the top level | `has an unknown field` |
| A field of the wrong type | `permissions.events` | `has the wrong type` |
| A bad value | `permissions.network[0]` | `must be a lowercase hostname, such as api.github.com` |
| A value that is too long | `server.entry` | `must be at most 1024 characters` |
| An out-of-range plugin | `api` | `doesn't include plugin API 0.2.0, which this host runs` |

## Changes

### 0.2.0

A breaking change ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)). To move a manifest from 0.1.0:

1. Replace `"entry": "dist/index.js"` with `"server": { "entry": "dist/index.js" }`.
2. Set `api` to `^0.2.0`.

`permissions.secrets` now lists the secrets the host may use for the plugin. A plugin that expected to receive a secret's value must ask the host to do the operation instead.

### 0.1.0

The first version ([decision 0038](../decisions/0038-plugin-manifest-and-api-range.md)).

## JSON Schema for editors

[`plugin-manifest.schema.json`](https://github.com/jcore9/Aphelion/blob/dev/packages/plugin-sdk/plugin-manifest.schema.json) ships in `@aphelion/plugin-sdk`. Point the manifest's `$schema` field at it, as in the example, and editors such as VS Code check the manifest as you type. The JSON Schema can't express the API-range rule, so only `parsePluginManifest` checks `api`. The rules in [Server and client parts](#server-and-client-parts) are in the JSON Schema too, generated from the same table the parser uses. The pattern for secret references uses Unicode character classes such as `\p{L}`, so a checker must read patterns in Unicode mode, as the JSON Schema library Ajv does by default. A test regenerates the file from the schema and fails when the committed copy is out of date. To regenerate it, run `bun --bun vitest run -u packages/plugin-sdk`.
