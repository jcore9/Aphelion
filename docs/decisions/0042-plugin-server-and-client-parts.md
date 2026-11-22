# 0042. A plugin has a server part, a client part or both, and its client part is installed on the server, served to every client and always sandboxed

- Status: Accepted
- Date: 2026-11-22
- Decided by: project owner
- Proposed by: the M0-13a follow-up PR ([#135](https://github.com/jcore9/Aphelion/issues/135))
- Answers: [#135](https://github.com/jcore9/Aphelion/issues/135), the plan's open decision "UI plugin isolation", and the design gap the security review of [#136](https://github.com/jcore9/Aphelion/pull/136) found
- Amended by: [its own amendment](#amendment-plugin-screens) from [#138](https://github.com/jcore9/Aphelion/issues/138) (plugins can add screens, with no grant)
- Amends: [0038](0038-plugin-manifest-and-api-range.md) (the single `entry` field, and the plugin API version), [0020](0020-1password-grok-bot-style.md) (how a plugin uses a secret), the plan's [Plugin types](../plan/aphelion-plan.md#plugins-and-themes) table and its "UI plugin isolation" default

## Context

The plan splits plugins into two types. A UI plugin runs in the client, in a sandboxed iframe that talks to the app through a message API ([decision 0008](0008-react-and-tailwind.md)). A server plugin runs on the server, in its own process, started by the plugin runner ([decision 0018](0018-shared-plugin-user.md)) from its installed package folder with Bun ([decision 0021](0021-container-init-and-secret-handoff.md)).

Many plugins need both. A weather plugin needs an API key and a network host on the server, and a panel in the app. The manifest from [decision 0038](0038-plugin-manifest-and-api-range.md) has one `entry` field, which assumes a server plugin.

Aphelion also has several clients: the web app (PWA), the desktop app, and a phone app later ([decision 0032](0032-native-app-stack-deferred.md)). Every client only connects to a server and never runs one ([decision 0017](0017-desktop-remote-only.md)). A client part must work in all of them.

The plan's recommended default for UI plugin isolation was "sandboxed iframes; in-page only for first-party plugins". In-page means the plugin's code runs inside the app's own page, with full access to it.

The first draft of this record kept secrets off the client part by allowing `permissions.secrets` only with a server part. The security review of #136 found that this isn't enough. If a server part receives a secret's value, it can send that value to its own client part through the app, and so to a device. The review also found that checking where a served file lives doesn't prove that its bytes are the ones that were installed.

## Options

The owner weighed these questions on 2026-11-22.

### Where a client part is installed

| | Installed once, on the server, and served to every client | Installed on each device |
| --- | --- | --- |
| Versions | Every device runs the version the server runs | Each device can run a different version, which may not match the server part |
| Install steps | One, on the server | One per device, repeated on a new phone or laptop |
| Permission grants | Granted once, on the server | Granted per device, or copied between them |
| Fits 0017 | Yes. A client holds nothing it can't get again from the server. | No. A client becomes a place where software is installed and managed. |
| Cost | The server serves the files, and each client downloads them when it connects | No download, but an install flow on every client, including the phone |

### How a client part runs

| | Always sandboxed | A trusted mode for some plugins |
| --- | --- | --- |
| What a plugin can reach | Only what the app's messages give it | The whole app, including the device token and every chat |
| Security review | One boundary, the message API, for every plugin | Each trusted plugin's code, on every update |
| First-party plugins | Use the same message API as anyone else, which keeps that API complete | Can take shortcuts the message API doesn't offer |
| Phone app | An iframe on web and desktop, a WebView on the phone, with the same messages | Needs a second way to run plugins inside the native app |
| Cost | Every effect a plugin needs must go through a message. Some effects run slower than they would in-page. | Two ways to run plugins, and two security models |

### How a plugin uses a secret

| | The host uses the secret for the plugin | The plugin receives the value |
| --- | --- | --- |
| Example | The plugin asks "make this HTTP call with my GitHub token", and the host makes the call | The host gives the plugin the token, and the plugin makes the call |
| Where the value can go | Nowhere new. It stays in the host and the broker. | Anywhere the plugin sends it: a log, a network host, its client part, a device |
| Fits the plan's `Secret` wrapper, which is never serialized | Yes. The value never crosses the plugin's channel. | No. The value has to be serialized to reach the plugin's process. |
| Cost | The host must offer each operation a plugin needs, starting with HTTP calls | None for the host. Each plugin must be trusted with each value. |

### Network access for a client part

| | None. A client part talks only to the app. | Hosts granted to the client part |
| --- | --- | --- |
| Where data can go | Only to the app, and from there through the server part | Straight from a device to any granted host |
| Network rules | The server part's traffic leaves from the container, under [decision 0022](0022-agent-network-boundary.md) | Traffic leaves from each device, outside the container's rules, the approval layer and the audit log |
| MCP servers | Reached from the server part, through the approval layer | Reached from the device, with no approval |
| Cost | A client part that shows remote data needs a server part to fetch it | One way less to fetch data, and a second network policy to enforce on every client |

### The plugin API version

| | Raise it to 0.2.0 | Keep 0.1.0 |
| --- | --- | --- |
| Follows the API's semver rule | Yes. Before 1.0.0, a breaking change raises the minor version. | No. A 0.1.0 manifest with `entry` would be refused by a host that still says 0.1.0. |
| Cost | Plugin authors change `api` to `^0.2.0` | None today, because no plugin or release uses the API yet |

## Decision

The owner decided six things:

1. **A plugin has a server part, a client part, or both.**
2. **A client part is installed once, on the server, and served to every client.** Each client downloads it from the server when it connects. Nothing is installed on a device, and every device runs the same version as the server.
3. **A client part always runs sandboxed**, in an isolated frame that talks to the app only through messages: an iframe on web and desktop, and a WebView on the phone. There is no trusted mode, for first-party plugins either.
4. **A plugin never sees a secret's value.** It asks the host to use a secret for it, for example to make an HTTP call with a token. `permissions.secrets` means "may ask the host to use these secrets in operations", not "may read them". The one exception is a secret backend, which declares `contributes.secretSchemes`. It produces values for the secrets broker, and only the broker receives them, never another plugin or a client part.
5. **A client part has no network access.** It talks only to the app. Any internet access, including to MCP servers, goes through the plugin's server part, with a granted `network` permission, and through the approval layer.
6. **The plugin API goes to version 0.2.0**, because dropping `entry` is a breaking change.

### The manifest

- **The manifest has an optional `server` part and an optional `client` part**, each with its own `entry` file. The single `entry` field is gone. A manifest needs at least one part.
- **The SDK's `PluginManifest` type describes a manifest that `parsePluginManifest` accepted.** It is a union of three shapes: server only, client only, or both. None of them lacks a part. A list that the plugin's parts can't use has the type `readonly never[]`, which is always empty, and every list is read-only. `pluginManifestSchema` on its own returns a looser type.
- **Each `entry` follows the path rules from 0038**: a plain relative path inside the plugin's folder, at most 1024 characters.
- **Permissions stay at the top of the manifest**, where #135 puts them, and each list needs the part that can use it:

  | List | Needs | Why |
  | --- | --- | --- |
  | `permissions.events` | either part | The server part gets events from the plugin host, and the client part through the app's messages. An animated avatar needs only agent status. |
  | `permissions.secrets` | a server part | The host uses each secret on the server, for the server part. No part receives a value. |
  | `permissions.network` | a server part | A client part has no network access. |
  | `permissions.uiSlots` | a client part | Only a client part can show anything in the app. |
  | `contributes.secretSchemes` | a server part | Secret backends run on the server, next to the secrets broker. |

  A non-empty list that needs a missing part is refused with a fixed reason, `needs a server part` or `needs a client part`. An empty list is allowed with either part. One table in the SDK drives the parser's check, the `PluginManifest` type and the JSON Schema rules. Its type allows only three values per list (server, client, or both), so it can't hold a list that no part may use.
- **A grant is per plugin, not per part.** When a plugin has both parts, events it is granted can go to either part. Putting a permission list inside each part would let the owner grant chat content to the server part and only agent status to the client part. That is a breaking change to the manifest, and it can come later if a plugin needs it.
- **Migration from 0.1.0:** `entry` becomes `server.entry`, and `api` becomes `^0.2.0`. The [manifest reference](../reference/plugin-manifest.md#changes) says so.

### MCP servers

The owner asked whether a client part could use an MCP server. It can't, whether the MCP server is local or remote. A plugin that uses an MCP server does so from its server part. The MCP server's host goes in `permissions.network`, and each tool call goes through the approval layer like any other tool call. A client part that needs the result asks the app, and the app gets it from the server part.

The reason is that a client part sees what the app shows it, which can include chat content. With its own network access, it could send that content from the device to any host. That traffic would skip the container's network rules ([decision 0022](0022-agent-network-boundary.md)), the approval layer and the audit log.

### The files served to devices

A check that a served file is inside the plugin's folder doesn't prove that its bytes are the ones that were installed. If a plugin's server code changed the files, a hash taken after the change would vouch for the changed bytes. So:

- **The host hashes every file of the client part at install time**, and keeps the hashes with the install record.
- **The host serves only those bytes.** A file whose bytes no longer match its install-time hash isn't served.
- **Plugin code can't write to an installed package folder.** Plugins run as `aphelion-plugins` ([decision 0018](0018-shared-plugin-user.md)), so the folder belongs to another user, or is read-only to `aphelion-plugins`. A plugin writes only to its own data folder.

### How it fits the earlier decisions

- **[0008](0008-react-and-tailwind.md)** put UI plugins in sandboxed iframes. This record keeps that, extends it to the phone as a WebView, and removes the plan's in-page exception for first-party plugins.
- **[0017](0017-desktop-remote-only.md)** makes every client connect-only. Serving client parts from the server keeps it that way: a client installs nothing, and a new device gets every plugin when it first connects.
- **[0018](0018-shared-plugin-user.md)** starts server plugins in the plugin runner, as `aphelion-plugins`, and says plugins never see secret values directly. Only the server part runs there. A client part never runs in the container, so it adds no process and no user. "They request them through the host" now means that a plugin asks the host to use a secret, not to hand it over.
- **[0020](0020-1password-grok-bot-style.md)** has the broker inject a value into a consumer's request, environment or headers. For a plugin, the host injects it only into the operation it makes for the plugin. It never goes into the plugin's environment or into a message to the plugin. 0020's grants per item, consumer and agent still apply.
- **[0021](0021-container-init-and-secret-handoff.md)** runs plugins from their installed package folders. The client part's files live in the same folder, which plugin code can't write. The server reads the files from there to serve them.
- **[0022](0022-agent-network-boundary.md)** requires a device token on every server endpoint except `/health`. Client parts are served through that authenticated API, so only a paired device can download them. A client part adds no traffic from the container, because it runs on the device and has no network access.
- **The plan's `Secret` wrapper** redacts itself in logs and JSON and is never serialized. Under this record, a value stays in that wrapper inside the host and the broker. It never crosses a plugin's channel, so the wrapper never needs to be serialized for a plugin.

## Consequences

- `@aphelion/plugin-sdk` replaces `entry` with `server` and `client` in the manifest, its JSON Schema and the [manifest reference](../reference/plugin-manifest.md). 0038's rule for `entry` now applies to `server.entry` and `client.entry`. `pluginApiVersion` is `0.2.0`.
- The plugin runner ([#100](https://github.com/jcore9/Aphelion/issues/100), M0-13b) starts `server.entry`, and skips a plugin that has only a client part. It runs each plugin from a folder that `aphelion-plugins` can't write, and a test shows that a plugin can't change its own files or another plugin's.
- The operations a plugin can ask the host to do with a secret, starting with an HTTP call, are designed in M0-13b ([#100](https://github.com/jcore9/Aphelion/issues/100)), the permission grants ([#101](https://github.com/jcore9/Aphelion/issues/101), M0-13c), and the M3 connector gateway. None of them may return a secret's value to a plugin.
- A secret backend, such as the 1Password plugin (M0-15), sees the values it produces. How the broker keeps those values from other plugins and client parts belongs to M0-14 and M0-15. So does how a backend gets its own credential, such as 1Password's service-account token.
- The plugin dev kit ([#106](https://github.com/jcore9/Aphelion/issues/106), M0-13e) covers server parts in M0. Its test host and template add client parts when M5 defines the message API. Its fake host must refuse to hand a secret's value to a plugin.
- The server needs a way to deliver client parts. Its design belongs to the M5 issues. It needs at least a versioned bundle per plugin, built from the install-time hashes and served over the authenticated API, so a client downloads a part again only when a hash changes.
- UI slots and the plugin sandbox ([#63](https://github.com/jcore9/Aphelion/issues/63), M5-11) build the iframe and the message API. A test must show that a client part in the sandbox can't open any network connection.
- The install flow ([#65](https://github.com/jcore9/Aphelion/issues/65), M5-13) installs and grants a plugin once, on the server, and hashes the client part's files at install time. Clients install nothing.
- The phone app needs a WebView that speaks the same message API as the iframe and blocks network access the same way, so a client part runs there unchanged. [Decision 0032](0032-native-app-stack-deferred.md) leaves the phone app's stack to M9, and that choice must support this.
- Revisit per-part permission lists when a plugin with both parts needs chat content on the server and only status on the client.

## Amendment: plugin screens

- Date: 2026-11-22
- Decided by: project owner
- Answers: [#138](https://github.com/jcore9/Aphelion/issues/138)

The owner decided two more things:

1. **A plugin can add whole screens.** A screen is a full page with an entry in the app's menu, in the web app, the desktop app and the phone app. The plugin's client part draws it, in the sandbox this record describes. The owner's example is a GitHub plugin with a screen of your issues and pull requests. Its server part fetches them from `api.github.com`, with a granted `network` permission, and asks the host to make each call with the GitHub token. It sends the results to the screen through the app's messages.
2. **A screen appears when its plugin is installed, with no separate grant**, unlike a UI slot. A UI slot needs a grant because it sits inside the chat and can show what is in it. A screen is a page of its own, and it can only show what its plugin can already reach. That still goes through the plugin's granted permissions: its server part, its network hosts and its secret operations. The owner can turn a screen off later.

### The manifest

- **`contributes.screens` lists the screens.** Each has an `id`, with the same rules as a plugin id and unique within the plugin, and a `title` of at most 64 visible characters. An `icon`, a name from the app's icon set, and a `menuOrder` from 0 to 999 are optional.
- **Screens need a client part.** The side table that drives the parser, the `PluginManifest` type and the JSON Schema gains `contributes.screens: client`, so a plugin with screens and no client part is refused with `needs a client part`.
- **Screens are a contribution, not a permission.** They say what the plugin adds, and grant it nothing.
- **The plugin API goes to 0.2.1.** The field is optional, so every 0.2.0 manifest stays valid and means the same, and the change isn't breaking. Before 1.0.0 an addition raises the patch version ([0038](0038-plugin-manifest-and-api-range.md)). A plugin with screens declares `^0.2.1`, so a 0.2.0 host refuses it by its range.

### Consequences

- The client shell ([#53](https://github.com/jcore9/Aphelion/issues/53)) builds the app's menu, which lists the screens that plugins add. It decides how screens from different plugins are told apart and how a screen is turned off.
- UI slots and the plugin sandbox ([#63](https://github.com/jcore9/Aphelion/issues/63), M5-11) run a screen's client part in the same sandbox as a UI slot, with the whole page as its area.
- The planned GitHub Work view (M5-06) is a natural first plugin screen, because the plan says first-party features are plugins on the same public API.
- The app's icon set, and the list that `icon` is checked against, belong to the client shell. Until then, any well-formed icon name is accepted.
