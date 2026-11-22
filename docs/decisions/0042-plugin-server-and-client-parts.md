# 0042. A plugin has a server part, a client part or both, and its client part is installed on the server, served to every client and always sandboxed

- Status: Accepted
- Date: 2026-11-22
- Decided by: project owner
- Proposed by: the M0-13a follow-up PR ([#135](https://github.com/jcore9/Aphelion/issues/135))
- Answers: [#135](https://github.com/jcore9/Aphelion/issues/135), and the plan's open decision "UI plugin isolation"
- Amends: [0038](0038-plugin-manifest-and-api-range.md) (the single `entry` field), the plan's [Plugin types](../plan/aphelion-plan.md#plugins-and-themes) table and its "UI plugin isolation" default

## Context

The plan splits plugins into two types. A UI plugin runs in the client, in a sandboxed iframe that talks to the app through a message API ([decision 0008](0008-react-and-tailwind.md)). A server plugin runs on the server, in its own process, started by the plugin runner ([decision 0018](0018-shared-plugin-user.md)) from its installed package folder with Bun ([decision 0021](0021-container-init-and-secret-handoff.md)).

Many plugins need both. A weather plugin needs an API key and a network host on the server, and a panel in the app. The manifest from [decision 0038](0038-plugin-manifest-and-api-range.md) has one `entry` field, which assumes a server plugin.

Aphelion also has several clients: the web app (PWA), the desktop app, and a phone app later ([decision 0032](0032-native-app-stack-deferred.md)). Every client only connects to a server and never runs one ([decision 0017](0017-desktop-remote-only.md)). A client part must work in all of them.

The plan's recommended default for UI plugin isolation was "sandboxed iframes; in-page only for first-party plugins". In-page means the plugin's code runs inside the app's own page, with full access to it.

## Options

The owner weighed two questions on 2026-11-22.

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

## Decision

The owner decided three things:

1. **A plugin has a server part, a client part, or both.**
2. **A client part is installed once, on the server, and served to every client.** Each client downloads it from the server when it connects. Nothing is installed on a device, and every device runs the same version as the server.
3. **A client part always runs sandboxed**, in an isolated frame that talks to the app only through messages: an iframe on web and desktop, and a WebView on the phone. There is no trusted mode, for first-party plugins either.

These rules follow for the manifest:

- **The manifest has an optional `server` part and an optional `client` part**, each with its own `entry` file. The single `entry` field is gone. A manifest needs at least one part. The SDK's `PluginManifest` type is a union of three shapes (server only, client only, both), so code that reads a parsed manifest can't hold one with neither part.
- **Each `entry` follows the path rules from 0038**: a plain relative path inside the plugin's folder, at most 1024 characters.
- **Permissions stay at the top of the manifest**, where #135 puts them, and each list needs the part that can use it:

  | List | Needs | Why |
  | --- | --- | --- |
  | `permissions.events` | either part | The server part gets events from the plugin host, and the client part through the app's messages. An animated avatar needs only agent status. |
  | `permissions.secrets` | a server part | A secret value must never reach a device. |
  | `permissions.network` | a server part | A client part gets data only through the app's messages. If it needs data from the internet, its server part fetches it, inside the network rules of [decision 0022](0022-agent-network-boundary.md). |
  | `permissions.uiSlots` | a client part | Only a client part can show anything in the app. |
  | `contributes.secretSchemes` | a server part | Secret backends run on the server, next to the secrets broker. |

  A non-empty list that needs a missing part is refused with a fixed reason, `needs a server part` or `needs a client part`. One table in the SDK drives the parser's check, the `PluginManifest` type and the JSON Schema rules, so the three can't disagree.
- **A grant is per plugin, not per part.** When a plugin has both parts, events it is granted can go to either part. Putting a permission list inside each part would let the owner grant chat content to the server part and only agent status to the client part. That is a breaking change to the manifest, and it can come later if a plugin needs it.
- **The plugin API stays at version 0.1.0.** Dropping `entry` would break a plugin, but no plugin and no release uses the API yet.

### How it fits the earlier decisions

- **[0008](0008-react-and-tailwind.md)** put UI plugins in sandboxed iframes. This record keeps that, extends it to the phone as a WebView, and removes the plan's in-page exception for first-party plugins.
- **[0017](0017-desktop-remote-only.md)** makes every client connect-only. Serving client parts from the server keeps it that way: a client installs nothing, and a new device gets every plugin when it first connects.
- **[0018](0018-shared-plugin-user.md)** starts server plugins in the plugin runner, as `aphelion-plugins`. Only the server part runs there. A client part never runs in the container, so it adds no process and no user.
- **[0021](0021-container-init-and-secret-handoff.md)** runs plugins from their installed package folders. The client part's files live in the same folder. The server reads them from there to serve them.
- **[0022](0022-agent-network-boundary.md)** requires a device token on every server endpoint except `/health`. Client parts are served through that authenticated API, so only a paired device can download them. A client part adds no traffic from the container, because it runs on the device.

## Consequences

- `@aphelion/plugin-sdk` replaces `entry` with `server` and `client` in the manifest, its JSON Schema and the [manifest reference](../reference/plugin-manifest.md). 0038's rule for `entry` now applies to `server.entry` and `client.entry`.
- The plugin runner ([#100](https://github.com/jcore9/Aphelion/issues/100), M0-13b) starts `server.entry`, and skips a plugin that has only a client part.
- The plugin dev kit ([#106](https://github.com/jcore9/Aphelion/issues/106), M0-13e) covers server parts in M0. Its test host and template add client parts when M5 defines the message API.
- The server needs a way to deliver client parts. Its design belongs to the M5 issues. It needs at least a versioned, content-hashed bundle per plugin, served over the authenticated API, so a client downloads a part again only when its hash changes. The server must check that every file it serves stays inside the plugin's folder, including through symbolic links.
- UI slots and the plugin sandbox ([#63](https://github.com/jcore9/Aphelion/issues/63), M5-11) build the iframe and the message API. The sandbox must block the client part's own network access, for example with a content security policy that allows no connections, or `permissions.network` would mean nothing on the client.
- The install flow ([#65](https://github.com/jcore9/Aphelion/issues/65), M5-13) installs and grants a plugin once, on the server. Clients install nothing.
- The phone app needs a WebView that speaks the same message API as the iframe, so a client part runs there unchanged. [Decision 0032](0032-native-app-stack-deferred.md) leaves the phone app's stack to M9, and that choice must support this.
- Revisit per-part permission lists when a plugin with both parts needs chat content on the server and only status on the client.
