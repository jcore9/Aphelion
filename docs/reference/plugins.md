# Running plugins on the server

A plugin's server part runs on the server as its own process. Two pieces run it:

- The **plugin host** lives inside the server. It reads each plugin's manifest, decides what the plugin may do, and talks to the plugin.
- The **plugin runner** is a separate small program that runs as the `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)). It starts and stops plugin processes, and passes messages between them and the host. It decides nothing.

The host and the runner talk over a pipe that the container's init creates before it drops privileges ([decision 0022](../decisions/0022-bot-network-boundary.md)). The server never signals a plugin process or reads `/proc` itself. It asks the runner.

A plugin with only a client part has no process. The host starts nothing for it ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

The code is in [`apps/server/src/plugins/`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/plugins/). The runner's process handling is in [`apps/server/src/adapters/plugin-processes.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/adapters/plugin-processes.ts).

## For plugin authors

You don't have to write JSON-RPC by hand. The SDK, `@aphelion/plugin-sdk`, does it for you. A plugin is an object with a `start` function, typed `ServerPlugin`. `@aphelion/plugin-sdk/stdio` connects it to the host, and `@aphelion/plugin-sdk/testing` has a fake host for tests. [Write your first server plugin](../guides/write-your-first-server-plugin.md) walks through them, and [the plugin API reference](plugin-api.md) lists every type and function in the SDK. The rest of this section says what the host does and expects, which is what the SDK builds on.

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
- Anything your plugin writes to standard error goes to the server's log, one line per entry, up to 1000 lines a minute. The notes about dropped long lines count toward the same 1000. The runner drops the rest of that minute and logs that it did.

Keep reading your standard input. Messages for your plugin wait in a buffer of about 16 MiB. The runner kills your plugin if either of these happens:

- Writing one message to your plugin's standard input takes more than 5 seconds.
- More than about 16 MiB of messages wait for your plugin.

The host has a similar limit the other way. If more than about 16 MiB, or more than 4096 messages, from your plugin wait for the host, the host drops them and counts it as a crash. The host counts each waiting message as twice its length plus 256 bytes, to cover the memory it really takes. In both cases the host restarts your plugin as after any other crash.

### Messages the host sends

| Message | Kind | Params | What your plugin does |
| --- | --- | --- | --- |
| `initialize` | request | `{ "api": "<host plugin API>", "plugin": "<id>" }` | Reply with any result, such as `{}`, within 10 seconds after the host sends it. The host counts the plugin as running only after this reply. An error reply counts as a crash. |
| `event` | notification | `{ "name": "<event>", "data": <event data> }` | Handle the event. You get only events you subscribed to and were granted. |
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

Your plugin asks for a named operation with `secrets.use`. The host chooses the destination and keeps both the secret value and the upstream response. The current server registers no operations. The secrets broker belongs to [#104](https://github.com/jcore9/Aphelion/issues/104).

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

The server starts the current version of every installed plugin when it starts, so restart the server after an install. Before every start, and before every automatic restart after a crash, the host checks three things:

- The manifest's `id` and `version` match the approved version.
- The files digest of the folder matches the approved one.
- The manifest asks only for permissions that were granted to that version.

If a check fails, the plugin doesn't start. An automatic restart logs `a plugin changed since it was approved, so it won't start`, with the reason. A running plugin keeps the grants of the version it started with, even after you approve a newer version.

Approvals from before this change don't carry over. After you upgrade Aphelion, approve each installed plugin once more with `plugin install`. In the container, plugins live under `/opt/aphelion/plugins` ([install a plugin](../guides/install.md#install-a-plugin)).

The host identifies `network.get` requests by the plugin's own channel. The request takes an HTTPS URL using the default port and an exact granted hostname. The host connects to a public IPv4 address, skips redirects, and limits the response to 64 KiB and the request to five seconds. The container's controls for direct network access are a separate boundary.

### Dev mode

Dev mode lets a plugin author reload one plugin without restarting the server. It is off unless you start the container with the override file [`deploy/compose.plugin-dev.yaml`](https://github.com/jcore9/Aphelion/blob/dev/deploy/compose.plugin-dev.yaml). That file mounts the folder named by `APHELION_PLUGIN_DEV_DIR` read-only at `/opt/aphelion/dev-plugin`, and starts the server with `--plugin-dev /opt/aphelion/dev-plugin`.

In dev mode the server opens a Unix socket at `plugin-dev.sock` in its state folder, so `/var/lib/aphelion/plugin-dev.sock` in the container. A Unix socket is a file that two programs on the same machine use to talk. Only `harness` can open it (mode `0600`). The server replaces a socket left over from an earlier run and removes it when it stops. Without `--plugin-dev`, the server opens no socket.

Preview and approve the mounted folder once, then watch it:

```sh
aphelion plugin install /opt/aphelion/dev-plugin
aphelion plugin install /opt/aphelion/dev-plugin --approve <value it printed>
aphelion plugin dev /opt/aphelion/dev-plugin
```

`plugin dev` asks the server to reload the plugin, then checks the folder about every half second and asks again after each change settles. It prints each answer at once. The handshake is the plugin's answer to `initialize`, which the SDK sends before it calls your `start`. When the plugin finished the handshake, the line on standard output is `Reloaded weather: the handshake finished.` When the plugin is in any other state, the line on standard error is `Reloaded weather, but it isn't running: crashed. The server log says why.`, with that run's state in place of `crashed`.

If that run then crashes before the next reload, the command prints one more line on standard error: `weather crashed after the handshake. If its start() failed, the server log says why.` A stop you asked for, such as another reload or stopping the service, does not print that line. Ctrl-C stops watching. The last run keeps running under the server.

Each reload stops the plugin, waits until it has stopped, reads the approval and the manifest again, and starts a new run through the runner. The runner checks the folder as on any other start, and the plugin runs as `aphelion-plugins` with its approved grants. Reloads run one at a time. The server refuses, with a reason:

- any folder other than the one given to `--plugin-dev`
- a folder with no approval
- a manifest that changed since its approval. The plugin then stays stopped until you run `plugin install` with `--approve` again and change a file.

A reload stops every plugin approved for the folder, then starts the one whose `id` the manifest names. So when you rename a plugin and approve the new name, the old name stops.

The socket accepts only reload requests, one at a time per connection. A request sent before the last one was answered is refused. It can't approve a plugin or start one from another folder.

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
