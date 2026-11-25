# Running plugins on the server

A plugin's server part runs on the server as its own process. Two pieces run it:

- The **plugin host** lives inside the server. It reads each plugin's manifest, decides what the plugin may do, and talks to the plugin.
- The **plugin runner** is a separate small program that runs as the `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)). It starts and stops plugin processes, and passes messages between them and the host. It decides nothing.

The host and the runner talk over a pipe that the container's init creates before it drops privileges ([decision 0022](../decisions/0022-bot-network-boundary.md)). The server never signals a plugin process or reads `/proc` itself. It asks the runner.

A plugin with only a client part has no process. The host starts nothing for it ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

The code is in [`apps/server/src/plugins/`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/plugins/). The runner's process handling is in [`apps/server/src/adapters/plugin-processes.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/plugin-processes.ts).

## For plugin authors

You don't have to write JSON-RPC by hand. The SDK, `@aphelion/plugin-sdk`, does it for you. A plugin is an object with a `start` function, typed `ServerPlugin`. `@aphelion/plugin-sdk/stdio` connects it to the host, and `@aphelion/plugin-sdk/testing` has a fake host for tests. [Write your first server plugin](../guides/write-your-first-server-plugin.md) walks through them, and [the plugin API reference](plugin-api.md) lists every type and function in the SDK. The SDK has no typed settings or storage API yet, on either host. A plugin's only storage is its data folder, which the deployed host sets up for it ([How your plugin is started](#how-your-plugin-is-started)). `createTestHost` has no data folder. The rest of this section says what the host does and expects, which is what the SDK builds on.

### How your plugin is started

Before it starts anything, the host reads `aphelion-plugin.json` and refuses the plugin if the manifest is invalid or its `api` range doesn't include the host's plugin API ([the API range](plugin-manifest.md#the-api-range)).

The runner then starts your server part as `bun --no-env-file <server.entry>`, with your installed plugin folder as the working folder. Your plugin can't change its own folder. The runner refuses to start the plugin if any of these is true:

- The `aphelion-plugins` user owns a file or folder in it. An owner can make a read-only file writable again, so read-only files aren't enough. Install plugins as another user, such as `root`.
- The `aphelion-plugins` user can write to a file or folder in it.
- A symbolic link in it points outside the folder. A symbolic link is a file that points to another path.
- `server.entry` leads outside the folder, after the runner follows symbolic links.
- The `aphelion-plugins` user owns, or can write to, a folder above the plugin's folder, up to `/`. It could swap the plugin's folder for another one after the check. A shared folder such as `/tmp` is allowed only with its "sticky" bit set, which stops users from renaming each other's files.

Your plugin gets a fresh environment. Nothing from the server's environment is passed on. Bun doesn't load a `.env` file from your folder. Your plugin has only these variables:

| Variable | Value |
| --- | --- |
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | Your plugin's data folder |
| `LANG` | `C.UTF-8` |
| `APHELION_PLUGIN_ID` | Your plugin's `id` |
| `APHELION_PLUGIN_DATA` | Your plugin's data folder |

Your server part asks the host to make network requests over its JSON-RPC channel. See [Permissions](#permissions).

Your data folder is `/var/lib/aphelion-plugins/<id>/`. The runner creates it with mode `0700`. It is the one place your plugin should write.

### Talking to the host

Your plugin talks to the host in [JSON-RPC 2.0](https://www.jsonrpc.org/specification). JSON-RPC is a small format for requests, replies and one-way notifications in JSON. Each message is one line of JSON:

- The host writes to your plugin's standard input.
- Your plugin writes to its standard output.
- A line can be at most 1 MiB. The runner drops a longer line and logs that it did.
- An event the host sends uses that same limit. The limit is 1 MiB of UTF-8 bytes of the whole JSON-RPC line, envelope included, not counting the newline. The host sends a longer event to no plugin. `createTestHost`'s `publish` rejects it.
- Anything your plugin writes to standard error goes to the server's log, one line per entry, up to 1000 lines a minute. The notes about dropped long lines count toward the same 1000. The runner drops the rest of that minute and logs that it did. `createTestHost` doesn't enforce this limit.

Keep reading your standard input. Messages for your plugin wait in a buffer of about 16 MiB. The runner kills your plugin if either of these happens:

- Writing one message to your plugin's standard input takes more than 5 seconds.
- More than about 16 MiB of messages wait for your plugin.

The host has a similar limit the other way. If more than about 16 MiB, or more than 4096 messages, from your plugin wait for the host, the host drops them and counts it as a crash. The host counts each waiting message as twice its length plus 256 bytes, to cover the memory it really takes. In both cases the host restarts your plugin as after any other crash.

### Messages the host sends

| Message | Kind | Params | What your plugin does |
| --- | --- | --- | --- |
| `initialize` | request | `{ "api": "<host plugin API>", "plugin": "<id>" }` | Reply with any result, such as `{}`, within 10 seconds after the host sends it. The host counts the plugin as running only after this reply. An error reply counts as a crash. |
| `event` | notification | `{ "name": "<event>", "data": <event data> }` | Handle the event. You get only events you subscribed to and were granted. The deployed server sends no events yet. |
| `shutdown` | notification | none | Finish your work and exit. The runner kills the plugin if it is still running 5 seconds later. See [When your plugin stops](#when-your-plugin-stops). |

### When your plugin stops

The host sends `shutdown` when the owner stops your plugin and when the Aphelion service stops. Your plugin then has 5 seconds to exit, in both cases. After that the runner kills it, and anything it hasn't saved is lost. Once the host has sent `shutdown`, it ignores everything your plugin writes. Treat a closed standard input like `shutdown`.

The SDK does this for you, in this order:

1. It stops taking events. An event that arrives after `shutdown` never reaches a handler.
2. Every call to the host that still waits for its reply fails at once with the error `the plugin is shutting down`. Every call made from then on fails the same way. That covers `network.get`, `secrets.use` and `events.subscribe`. A handler that awaits one of these calls gets the error and can still finish its own work.
3. It waits for `start` to finish, because the cleanup comes from `start`. This wait has no limit of its own, so a `start` that is still running after 5 seconds is killed with the plugin, and cleanup never runs.
4. It waits for the event handlers that are still running, until 3 seconds after shutdown began.
5. It runs the cleanup function that `start` returned. Cleanup closes your files and connections.
6. The process exits.

A handler that still runs after 3 seconds isn't stopped. The SDK logs `the handler for <event> was still running after 3 s, so the plugin's cleanup runs now` and runs your cleanup anyway, so that handler can find its files or connections already closed. The log names the event, never its data. When `start` has already finished, the 3 seconds leave about 2 seconds of the 5 for your cleanup. A `start` that finishes later leaves less. Keep handlers short, and save their work as they go.

`createTestHost` behaves the same way. Its `publish` sends nothing from the moment you call `stop`.

### Requests your plugin can send

| Method | Params | Result |
| --- | --- | --- |
| `events.subscribe` | `{ "event": "<name>" }` | `{}`. The error `-32001 Not granted` if the event isn't in your manifest's `permissions.events` or the owner hasn't granted it. |
| `network.get` | `{ "url": "https://api.example.com/path" }` | `{ "status": 200, "body": "..." }`. The destination must be in `permissions.network` and granted. |
| `secrets.use` | `{ "operation": "<name>", "reference": "<secret reference>" }` | `{}` after the host completes the operation. The host checks the grant for the secret reference and the destination it configured for the operation. |

Subscriptions last until the process exits. After a restart, subscribe again. Network and secret operations require a running server part. Each plugin can have one such operation in progress at a time.

### Errors

| Code | Message | When |
| --- | --- | --- |
| `-32700` | `Parse error` | Your line isn't JSON. The reply has `"id": null`. |
| `-32600` | `Invalid request` | Your line is JSON, but not a JSON-RPC 2.0 message. The reply has `"id": null`. |
| `-32601` | `Method not found` | The host has no such method. |
| `-32602` | `Invalid params` | The params don't match the method. |
| `-32001` | `Not granted` | Your plugin may not do this. |
| `-32002` | `The host doesn't offer secret operations yet` | The host has no secret operations configured. |
| `-32003` | `Operation failed` | The operation failed. The response omits internal error details. |
| `-32004` | `Operation in progress` | This plugin already has a network or secret operation in progress. |

### Secrets

Your plugin asks for a named operation with `secrets.use`. The host chooses the destination and keeps both the secret value and the upstream response. The current server registers no operations, so the deployed host doesn't run any `secrets.use` call yet and returns `-32002`. `createTestHost` can run an operation that a test registers, so a test can see the call succeed where the server refuses it. The secrets broker belongs to [#104](https://github.com/jcore9/Aphelion/issues/104).

The host also refuses to send any message that holds a [`Secret`](secrets.md), because a `Secret` throws when it is turned into JSON. The event is then sent to no plugin.

### Crashes and restarts

The host restarts a plugin that crashes. A crash is any of these:

- The process exits while it is running or starting.
- The runner can't start it.
- It doesn't answer `initialize` within 10 seconds. The runner kills it.
- It answers `initialize` with an error. The runner kills it.
- It stops reading its standard input, or it writes faster than the host can handle. See [Talking to the host](#talking-to-the-host).

The restarts after the first five crashes in a row wait 1, 2, 4, 8 and 16 seconds. After the sixth crash in a row, the host stops the plugin and doesn't restart it. A crash after a run stayed up 60 seconds or more counts as the first crash in a row. This applies to every crash in the list above.

### Child processes

Your plugin can start child processes. When the plugin stops, the runner tries to kill every process your plugin started, including children of children. This is best effort: [decision 0046](../decisions/0046-plugin-runner-kills-process-trees.md) lists the rare cases it misses, and the runner logs an error when a process is still there after the kill.

Keep your child processes attached to your plugin. A process that detaches, for example with `setsid` and a double fork, leaves your plugin's process tree. The runner's sweep kills every such process it finds every 10 seconds, and it also kills them whenever it stops any plugin, whichever plugin they came from ([decision 0046](../decisions/0046-plugin-runner-kills-process-trees.md)).

## For operators

### What a plugin goes through

Each plugin with a server part is in one of these states. The host's `status` call returns it, and the server logs every change as `plugin state changed`.

| State | Meaning |
| --- | --- |
| `installed` | The host knows the plugin and hasn't started it. |
| `starting` | The runner started the process, and the host waits for the `initialize` reply. |
| `running` | The plugin answered `initialize`. It gets the events it subscribed to and was granted. |
| `stopping` | The host sent `shutdown` and waits 5 seconds before the runner kills the plugin. A plugin that is still starting is killed at once. When the server stops, every plugin is in this state at the same time. |
| `crashed` | The plugin crashed. The host restarts it after the wait in [Crashes and restarts](#crashes-and-restarts). |
| `stopped` | The plugin was stopped on request, or it crashed too often. |

Each start gets a new run number. Every message between the host and the runner carries it, so a late message from a killed process can't change the state of the new one. Each timer also has a purpose (the `initialize` deadline, the shutdown grace time, or the restart wait). A timer counts only in the state that set it. For example, the `initialize` deadline can't cut the shutdown grace time short.

### Permissions

A plugin gets an event only if both are true:

- Its manifest asks for it.
- The owner granted it.

Put the unpacked plugin in its final location, where only you can change it. Run the install command to preview its permission requests.

```sh
aphelion plugin install /path/to/plugin
```

If you accept the listed permissions, repeat the command with the displayed `--approve` argument. Use the same `--state-dir` as the server if you changed the default.

The approval covers every file in the folder, not only the manifest. The install command computes a digest of the folder: a SHA-256 hash of each file's path and contents, combined into one value. Hidden files count. The command refuses a folder that holds a symbolic link or another special file, more than 1000 files, or more than 64 MiB.

The `--approve` value is a hash of these parts:

- the plugin's `id` and `version`
- the version that is approved now, if any
- the folder
- the permission list
- the files digest

The value stops working when any of these parts changes. So a value printed before another approval of the same plugin no longer matches. Preview again to get a new one.

The install command records each approved version with its folder, its files digest and its grants, in SQLite. A grant belongs to one version of a plugin. When you approve a new version, the server keeps the version it replaces as the previous one. Approving the same version again replaces that version's folder, digest and grants.

The server starts the current version of every installed plugin when it starts, so restart the server after an install. Before every start, and before every automatic restart after a crash, the host checks the approval and requested permissions.

- The manifest's `id`, `version`, and canonical folder still have an approval, even when the plugin requests no permissions.
- The files digest of the folder matches the approved one. Dev mode skips this check for the configured dev folder.
- The manifest asks only for permissions that were granted to that version.

If a check fails, the plugin doesn't start. An automatic restart logs `a plugin changed since it was approved, so it won't start`, with the reason. A running plugin keeps the grants of the version it started with, even after you approve a newer version.

Approvals from before this change don't carry over. After you upgrade Aphelion, approve each installed plugin once more with `plugin install`. In the container, plugins live under `/opt/aphelion/plugins` ([install a plugin](../guides/install.md#install-a-plugin)).

The install command also records the manifest's `repository`, so a plugin installed from a folder can [update](#updates) from that repository's releases.

The host identifies `network.get` requests by the plugin's own channel. The request takes an HTTPS URL using the default port and an exact granted hostname. The host connects to a public IPv4 address, skips redirects, and limits the response to 64 KiB and the request to five seconds. The container's controls for direct network access are a separate boundary.

### Which bots may use a plugin

You approve a plugin's permissions once, for the whole server, as described above. Which bots may use the plugin is a separate switch ([decision 0058](../decisions/0058-specialized-bots.md)).

- Each bot has an on/off switch for each plugin and each connector. A new bot starts with every switch off. You turn on what the bot needs.
- The switch decides which bots can call the plugin's tools. It never adds a permission, and it can't narrow the plugin's grant for one bot.
- The grant has no per-bot version. To limit one bot more, for example to read-only on GitHub, write a policy rule for that bot, that connector and those tools.
- 1Password grants are the exception. They stay per item, per consumer and per bot ([decision 0020](../decisions/0020-1password-grok-bot-style.md)).

The host decides from the manifest which plugins get a switch. A plugin gets one when it contributes something a bot calls: a tool, a connector or a custom MCP server. A plugin that only serves the server or the app has no switch, and is still limited to the permissions you granted it. That covers secret backends (`contributes.secretSchemes`), themes, notifiers, and UI plugins, including one that shows bot status. Nothing on the server runs secret backends, screens or UI slots yet, and `createTestHost` doesn't run them either. A bot adapter has no switch, because a bot's `provider` setting selects it. Reviewers and routine triggers have none either: the policy engine calls the reviewer, and each routine selects its trigger.

No manifest field names a tool or a connector yet. The connector contract (M3-02) adds it. Until then, no plugin has a switch. The switches themselves come with M3-06, M4-02 and M5-13.

### Updates

The host checks a folder install's files just before the runner starts them, so leave the files unchanged while the folder is installed.

A plugin whose manifest names a `repository` updates from that repository's GitHub releases. Each update waits for your approval. The server keeps running, and only the plugin restarts. [Update a plugin](../guides/install.md#update-a-plugin) shows the commands in the container.

`aphelion plugin update ID` reads the repository's latest full release, downloads it, checks it, and prints a preview. Nothing is installed yet.

```text
Plugin aphelion-test-plugin can update from 1.0.0 to 1.1.0.
GitHub attests that jcore9-bot/aphelion-test-plugin's release workflow built 1.1.0 from tag v1.1.0.
adds	events	"bot.status"
Review the changes above. To install 1.1.0 and grant its permissions, repeat the command with --approve <value it printed>
```

A line that starts with `adds` names a permission the new version asks for. A line that starts with `drops` names one it no longer asks for. When the list doesn't change, the preview says `No permission changes.` The `--approve` value is a SHA-256 hash of two approvals: the installed version's (its version, folder, files digest and grants) and the release's (its version, final folder, files digest and permissions). It has its own label, so a value from `plugin install` never works here. The command downloads and checks the release again on the approving run, so the value works only while both stay the same. If you approve the installed version again in between, even at the same version, preview the update again.

With `--approve`, the command moves the release into place, records it as the current version with its grants, and keeps the version it replaces as the previous one. Then it asks the server, through the [control socket](#control-socket), to restart the plugin:

```text
Updated aphelion-test-plugin from 1.0.0 to 1.1.0.
aphelion-test-plugin 1.1.0 runs.
```

When the server isn't running, the second line is `The server isn't running, so aphelion-test-plugin starts on 1.1.0 when the server starts.` The command still exits with code 0. For a plugin with only a client part, the second line is `aphelion-test-plugin has no server part to restart.`

When a plugin with a server part fails to start or stops during the 10-second watch, the command goes back at once. It points the plugin at the old version again and tries to restart it. If that restart fails too, Aphelion keeps both versions and their approvals. After a successful restart, Aphelion drops the failed version's approval and removes its files if no approval still names them. The command exits with code 1. Standard error then says which state the new version reached and where the old one is now, for example `aphelion-test-plugin 1.1.0 didn't start (it is crashed), so Aphelion went back to 1.0.0.`

When the latest release is the installed version, the command prints `aphelion-test-plugin is already on 1.1.0, the latest release. If the server still runs an older version, run aphelion plugin restart aphelion-test-plugin.` and exits with code 0. If an `--approve` run stops after recording the new version and before asking for the restart, the server can still run the older version. `aphelion plugin restart ID` asks the server to restart the plugin on its approved version. `plugin update` never goes to an older version. It refuses a latest release that is older than the installed version.

`aphelion plugin rollback ID` goes back one version and restarts the plugin on it:

```text
Went back from aphelion-test-plugin 1.1.0 to 1.0.0.
aphelion-test-plugin 1.0.0 runs.
```

When the earlier version fails to start or stops during the 10-second watch, the rollback undoes itself. The plugin points at the version it left again, with the earlier one as previous, and restarts on it. Nothing is deleted. Standard error says what happened, for example `aphelion-test-plugin 1.0.0 didn't start (it is crashed), so Aphelion stayed on 1.1.0.`, and the command exits with code 1.

The server keeps two versions of each plugin, the current one and the one before it. A rollback makes the one before current, and deletes the version it left. So a second rollback is refused with `aphelion-test-plugin has no earlier version to go back to.` To return to the newer version, run `plugin update` again.

Every refusal is one sentence on standard error, with exit code 1.

#### What a release must hold

The release workflow that `create:plugin` generates makes releases in this form ([publish a release](../guides/write-your-first-server-plugin.md#publish-a-release)):

- The tag is `v` and the manifest's `version`, such as `v1.1.0`. For updates, use three numbers such as `1.1.0`. The release workflow rejects build metadata such as `+build`.
- The release is a full release, not a draft or a pre-release. `plugin update` reads only GitHub's latest release.
- The asset `aphelion-plugin.tar` is a plain POSIX ustar archive with no compression. It holds the contents of the plugin's `dist/` folder at its root. A leading `./` on each name is fine.
- The asset `aphelion-plugin.tar.sigstore.json` is the attestation that `actions/attest-build-provenance` wrote for that archive.
- The archive's `aphelion-plugin.json` has the installed plugin's `id`, the tag's version, and the installed `repository` in any mix of upper and lower case. Its `api` range includes the plugin API that this server runs.

#### What the check proves

An artifact attestation is a signed statement from GitHub that a workflow run built a file with a given SHA-256 hash. GitHub signs it through Sigstore, a public signing service that also records every signature in a public log. Before Aphelion opens the archive, it checks all of these:

- The signature leads back to Sigstore's keys in the trust root that ships with Aphelion, [`trusted-root.json`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/plugins/updates/trusted-root.json). Sigstore's transparency log and certificate log both recorded it.
- GitHub Actions signed it, for the workflow `.github/workflows/release.yml` of the repository the plugin names, run for the tag `v<version>`.
- The signed statement describes a build of one file, `aphelion-plugin.tar`, whose SHA-256 equals that of the bytes Aphelion downloaded.

The check doesn't prove that the code is safe. It proves which repository, workflow and tag built the archive. Anyone who can push a tag to that repository can publish a release that passes. Read the permission changes in each preview. The first `plugin install` from a folder decides which repository counts, so check the manifest's `repository` before you approve it.

Aphelion never downloads the trust root while it runs. When Sigstore replaces its keys, an older Aphelion refuses new releases with a message that the release isn't genuine, or is signed with a key this Aphelion doesn't know. Upgrade Aphelion to fix it. Maintainers refresh the file with `bun scripts/update-trusted-root.ts`, which prints the keys it added and removed.

#### Limits

| What | Limit |
| --- | --- |
| Hosts | `api.github.com`, `github.com`, `objects.githubusercontent.com` and `release-assets.githubusercontent.com`, over HTTPS on the default port, with no user name or password in the address |
| Redirects | 3, each checked against the hosts above |
| Time | 30 seconds for each request |
| Release information | 1 MiB |
| `aphelion-plugin.tar.sigstore.json` | 1 MiB |
| `aphelion-plugin.tar` | 32 MiB |
| Archive entries | Files and folders only, and at most 1000 of them. No links, devices or extended headers. Every name stays inside the folder, at most 32 levels deep. |
| Unpacked files | 16 MiB for one file, 64 MiB in all |

Aphelion sends no GitHub token, so public repositories work and private ones don't. GitHub limits requests without a token for each address. When the limit is used up, the refusal says when it resets.

#### Where the files go

- A release is unpacked first into `.staging` in the plugins folder, then moved to `<id>@<version>`, such as `/opt/aphelion/plugins/aphelion-test-plugin@1.1.0`. Folders get mode `0755` and files `0644`, whatever the archive says.
- At the start of every update and rollback, Aphelion removes abandoned staging files and unapproved `<id>@<version>` directories. This recovers a release folder left by an interrupted update so the next update can install it again. Cleanup keeps approved folders, their contents, and every directory or symbolic link Aphelion passes through to reach them. An update whose destination still exists reports `FOLDER already exists. Move it away, then update again.`
- After a switch that worked, Aphelion deletes the records of versions that are neither current nor previous. It deletes a release's folder, at the path its record names, only when no other approved version names that folder. It never deletes a folder that you installed with `plugin install`.
- `plugin install` refuses a folder inside `.staging`, or a release folder `<id>@<version>` in the plugins folder, with `FOLDER is a release folder that plugin update manages, so it can't be installed as a folder. Copy it to another folder first.` It compares real paths, so a symbolic link to the plugins folder doesn't get around it.
- `plugin install`, `plugin update` and `plugin rollback` take turns through a kernel lock on the file `plugin-files.lock` in the state folder. A second command refuses with `Another plugin install, update or rollback is running, so try again when it finishes.` The kernel drops the lock when the command that holds it ends, even when it is killed, so a lock is never left behind.

`plugin install`, `plugin update` and `plugin rollback` take `--plugins-dir DIR`, `/opt/aphelion/plugins` unless given, and `--state-dir`.

#### Testing with a local GitHub

`APHELION_GITHUB_API` is for tests only. Set it to an origin, such as `http://127.0.0.1:8099`, and `plugin update` sends every request there instead of to GitHub, over plain HTTP if the origin says so. The attestation check doesn't change, so only real attested releases pass. The image contract test runs [`deploy/test/fake-github.mjs`](https://github.com/jcore9/Aphelion/blob/main/deploy/test/fake-github.mjs) in the container with the releases in [`apps/server/src/plugins/updates/fixtures`](https://github.com/jcore9/Aphelion/tree/main/apps/server/src/plugins/updates/fixtures). Don't set the variable on a real server.

### Dev mode

Dev mode lets a plugin author reload one plugin without restarting the server. It is off unless you start the container with the override file [`deploy/compose.plugin-dev.yaml`](https://github.com/jcore9/Aphelion/blob/main/deploy/compose.plugin-dev.yaml). That file mounts the folder named by `APHELION_PLUGIN_DEV_DIR` read-only at `/opt/aphelion/dev-plugin`, and starts the server with `--plugin-dev /opt/aphelion/dev-plugin`.

`plugin dev` talks to the server through the [control socket](#control-socket). In dev mode, the server also accepts reload requests on it.

Preview and approve the mounted folder once, then watch it:

```sh
aphelion plugin install /opt/aphelion/dev-plugin
aphelion plugin install /opt/aphelion/dev-plugin --approve <value it printed>
aphelion plugin dev /opt/aphelion/dev-plugin
```

`plugin dev` asks the server to reload the plugin, then checks the folder about every half second and asks again after each change settles. It prints each answer at once. The handshake is the plugin's answer to `initialize`, which the SDK sends before it calls your `start`. When the plugin finished the handshake, the line on standard output is `Reloaded weather: the handshake finished.` When the plugin is in any other state, the line on standard error is `Reloaded weather, but it isn't running: crashed. The server log says why.`, with that run's state in place of `crashed`.

If that run then crashes before the next reload, the command prints one more line on standard error: `weather crashed after the handshake. If its start() failed, the server log says why.` A stop you asked for, such as another reload or stopping the service, does not print that line. Ctrl-C stops watching. The last run keeps running under the server.

Each reload stops the plugin, waits until it has stopped, reads the approval and the manifest again, and starts a new run through the runner. The runner checks the folder as on any other start, and the plugin runs as `aphelion-plugins` with its approved grants. Reloads run one at a time.

In the dev folder, the approval covers the permissions and the version, not the files. So a code change needs no new approval. The server refuses, with a reason:

- any folder other than the one given to `--plugin-dev`
- a folder with no approval
- a manifest whose `id` or `version` differs from the approved one
- a manifest that asks for a permission that wasn't granted

After a refusal, the plugin stays stopped until you run `plugin install` with `--approve` again and change a file.

A reload stops every plugin approved for the folder, then starts the one whose `id` the manifest names. So when you rename a plugin and approve the new name, the old name stops.

### Control socket

The server opens a Unix socket at `plugin-control.sock` in its state folder whenever it runs plugins, so `/var/lib/aphelion/plugin-control.sock` in the container. A Unix socket is a file that two programs on the same machine use to talk. Only `harness` can open it (mode `0600`). The server replaces a socket left over from an earlier run and removes it when it stops.

The socket takes one JSON request per line, and answers each one on one line:

| Request | Answer |
| --- | --- |
| `{"type":"restart","plugin":"ID"}` | The server stops the plugin, starts its approved version with every check in [permissions](#permissions), and waits up to 15 seconds for the run to settle. Once the run reaches `running`, the server watches it for 10 more seconds and reports the state the run enters if it stops running during that watch. It answers `{"type":"restarted","plugin":"ID","state":"STATE"}`. |
| `{"type":"reload","folder":"FOLDER"}` | Only in [dev mode](#dev-mode). Without `--plugin-dev`, the server answers `{"type":"refused","reason":"dev mode is off"}`. |

`plugin update` and `plugin rollback` send `restart` after they switch the version. `plugin restart` sends the same request for the approved version. A request the server can't carry out gets `{"type":"refused","reason":"..."}`, for example for a plugin that isn't installed. Requests run one at a time, and each connection may have one request waiting for an answer. A request sent before the last one was answered is refused, and so is a line longer than 64 KiB. The socket can't approve a plugin, and it starts only approved versions.

### Isolation between plugins

Every server plugin runs as the same `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)), with Docker's default seccomp profile and no namespaces of its own ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)). The host's permission checks keep plugins apart. The operating system doesn't. One plugin can read another plugin's data folder and send signals to its processes. Install only plugins you trust.

The runner also runs as `aphelion-plugins`, so a plugin can send signals to the runner too. When the runner dies, its pipe closes, and the host logs `the plugin runner's pipe closed`.

### What the runner relies on

The runner trusts every message on its standard input. Only the server may write there. The runner protects its pipe in two ways:

- The runner marks itself as not dumpable with `prctl(PR_SET_DUMPABLE, 0)`. Linux then hides the runner's memory and open files from other processes of the same user. A plugin can't open the runner's pipe through `/proc/<runner>/fd/` or attach a debugger to the runner. A test checks that a process of the same user can't read where `/proc/<runner>/fd/0` points, which Linux refuses for the same reason it refuses opening it.
- The runner gives each plugin new pipes for its standard input, output and error. A plugin doesn't inherit the runner's pipe.

The [container](container.md#how-the-processes-start) makes sure of the rest, and its contract test checks each point:

- The launcher creates the pipe before it drops privileges, and only the server and the runner hold its ends.
- No file in the file system leads to the pipe, and no other process gets a copy of its ends.
- The `aphelion-plugins` user can't open the server's pipes, read its memory or signal it.

### Running the runner

The container's launcher starts the runner as `aphelion-plugins`, with the pipe to the server on its standard input and output:

```sh
bun /usr/local/lib/aphelion/plugin-runner.js --bun /usr/local/bin/bun --data /var/lib/aphelion-plugins
```

`bun run --filter @aphelion/server build:plugin-runner` bundles `apps/server/src/plugins/runner-main.ts` into that one file.

| Option | Default | Meaning |
| --- | --- | --- |
| `--bun` | The Bun that runs the runner | The Bun binary that starts each plugin. |
| `--data` | `/var/lib/aphelion-plugins` | The folder that holds one data folder per plugin. |

The runner logs to its standard error. It logs an error if it couldn't kill every process of a plugin. When the pipe closes, the runner kills every plugin and exits.

### When the server stops

The host stops every plugin before it closes the pipe to the runner ([decision 0054](../decisions/0054-graceful-plugin-stop-deadlines.md)):

1. It logs `the plugin host is stopping every plugin` and stops taking `start` requests.
2. It sends `shutdown` to every running plugin at the same time. A plugin that is still starting is killed at once. A plugin that waits to restart after a crash stays stopped.
3. Each plugin gets the usual 5 seconds to exit. The runner kills a plugin that is still running after that.
4. The whole stop takes at most 10 seconds. If a plugin still hasn't stopped after 9 seconds, the host logs which ones and tells the runner to kill them. It then closes the pipe, and the runner kills anything left.

The 10 seconds fit inside the 20 seconds that the container's launcher gives the server to exit. See [Stopping](container.md#stopping).

If the server closes its end first, the runner logs `the plugin runner couldn't write to the server` and exits when its standard input closes.
