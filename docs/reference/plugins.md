# Running plugins on the server

A plugin's server part runs on the server as its own process. Two pieces run it:

- The **plugin host** lives inside the server. It reads each plugin's manifest, decides what the plugin may do, and talks to the plugin.
- The **plugin runner** is a separate small program that runs as the `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)). It starts and stops plugin processes, and passes messages between them and the host. It decides nothing.

The host and the runner talk over a pipe that the container's init creates before it drops privileges ([decision 0022](../decisions/0022-agent-network-boundary.md)). The server never signals a plugin process or reads `/proc` itself. It asks the runner.

A plugin with only a client part has no process. The host starts nothing for it ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

The code is in [`packages/server/src/plugins/`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/plugins/). The runner's process handling is in [`packages/server/src/adapters/plugin-processes.ts`](https://github.com/jcore9/Aphelion/blob/dev/packages/server/src/adapters/plugin-processes.ts).

## For plugin authors

### How your plugin is started

Before it starts anything, the host reads `aphelion-plugin.json` and refuses the plugin if the manifest is invalid or its `api` range doesn't include the host's plugin API ([the API range](plugin-manifest.md#the-api-range)).

The runner then starts your server part as `bun <server.entry>`, with your installed plugin folder as the working folder. Your plugin can't change its own folder. If the `aphelion-plugins` user can write to any file or folder in it, the runner refuses to start the plugin.

Your plugin gets a fresh environment. Nothing from the server's environment is passed on. It has only these variables:

| Variable | Value |
| --- | --- |
| `PATH` | `/usr/local/bin:/usr/bin:/bin` |
| `HOME` | Your plugin's data folder |
| `LANG` | `C.UTF-8` |
| `APHELION_PLUGIN_ID` | Your plugin's `id` |
| `APHELION_PLUGIN_DATA` | Your plugin's data folder |
| `HTTPS_PROXY`, `https_proxy`, `NO_PROXY`, `no_proxy` | The network proxy. Set only when the owner granted your plugin at least one host from `permissions.network`. |

Your data folder is `/var/lib/aphelion-plugins/<id>/`. The runner creates it with mode `0700`. It is the one place your plugin should write.

### Talking to the host

Your plugin talks to the host in [JSON-RPC 2.0](https://www.jsonrpc.org/specification). JSON-RPC is a small format for requests, replies and one-way notifications in JSON. Each message is one line of JSON:

- The host writes to your plugin's standard input.
- Your plugin writes to its standard output.
- A line can be at most 1 MiB. The runner drops a longer line and logs that it did.
- Anything your plugin writes to standard error goes to the server's log, one line per entry.

### Messages the host sends

| Message | Kind | Params | What your plugin does |
| --- | --- | --- | --- |
| `initialize` | request | `{ "api": "<host plugin API>", "plugin": "<id>" }` | Reply with any result, such as `{}`, within 10 seconds. The host counts the plugin as running only after this reply. An error reply counts as a crash. |
| `event` | notification | `{ "name": "<event>", "data": <event data> }` | Handle the event. You get only events you subscribed to and were granted. |
| `shutdown` | notification | none | Exit. The runner kills the plugin if it is still running 5 seconds later. |

### Requests your plugin can send

| Method | Params | Result |
| --- | --- | --- |
| `events.subscribe` | `{ "event": "<name>" }` | `{}`. The error `-32001 Not granted` if the event isn't in your manifest's `permissions.events` or the owner hasn't granted it. |
| Any method that starts with `secrets.` | any | Always the error `-32002 The host doesn't offer secret operations yet`. |

Subscriptions last until the process exits. After a restart, subscribe again.

### Errors

| Code | Message | When |
| --- | --- | --- |
| `-32700` | `Parse error` | Your line isn't JSON. The reply has `"id": null`. |
| `-32600` | `Invalid request` | Your line is JSON, but not a JSON-RPC 2.0 message. The reply has `"id": null`. |
| `-32601` | `Method not found` | The host has no such method. |
| `-32602` | `Invalid params` | The params don't match the method. |
| `-32001` | `Not granted` | Your plugin may not do this. |
| `-32002` | `The host doesn't offer secret operations yet` | Your plugin asked for a secret operation. |

### Secrets

Your plugin never receives a secret's value. Your plugin will ask the host to use a secret for it, for example to sign an HTTP call, and the host will do the work. That operations API doesn't exist yet. Until it does, the host refuses every `secrets.` request.

The host also refuses to send any message that holds a [`Secret`](secrets.md), because a `Secret` throws when it is turned into JSON. The event is then sent to no plugin.

### Crashes and restarts

The host restarts a plugin that crashes. A crash is any of these:

- The process exits while it is running or starting.
- The runner can't start it.
- It doesn't answer `initialize` within 10 seconds. The runner kills it.
- It answers `initialize` with an error. The runner kills it.

The first restart waits 1 second. Each crash in a row doubles the wait, up to 60 seconds. After the sixth crash in a row, the host stops the plugin and doesn't restart it. A run that stays up for 60 seconds or more resets the count.

### Child processes

Your plugin can start child processes. When the plugin stops, the runner kills every process your plugin started, including children of children.

Keep your child processes attached to your plugin. A process that detaches, for example with `setsid` and a double fork, leaves your plugin's process tree. The runner kills every such process within 10 seconds ([decision 0046](../decisions/0046-plugin-runner-kills-process-trees.md)).

## For operators

### What a plugin goes through

Each plugin with a server part is in one of these states. The host's `status` call returns it, and the server logs every change as `plugin state changed`.

| State | Meaning |
| --- | --- |
| `installed` | The host knows the plugin and hasn't started it. |
| `starting` | The runner started the process, and the host waits for the `initialize` reply. |
| `running` | The plugin answered `initialize`. It gets the events it subscribed to and was granted. |
| `stopping` | The host sent `shutdown` and waits up to 5 seconds before the runner kills the plugin. A plugin that is still starting is killed at once. |
| `crashed` | The plugin crashed. The host restarts it after the wait in [Crashes and restarts](#crashes-and-restarts). |
| `stopped` | The plugin was stopped on request, or it crashed too often. |

Each start gets a new run number. The host ignores messages and timers from an earlier run, so a late message from a killed process can't change the state of the new one.

### Permissions

A plugin gets an event or the network proxy only if both are true:

- Its manifest asks for it.
- The owner granted it.

Grants come from issue [#101](https://github.com/jcore9/Aphelion/issues/101), which isn't built yet. Until then the host grants nothing. Plugins start and run, but they get no events and no proxy.

### Isolation between plugins

Every server plugin runs as the same `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)), with Docker's default seccomp profile and no namespaces of its own ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)). The host's permission checks keep plugins apart. The operating system doesn't. One plugin can read another plugin's data folder and send signals to its processes. Install only plugins you trust.

### Running the runner

The container's init starts the runner as `aphelion-plugins`, with the pipe to the server on its standard input and output:

```sh
bun packages/server/src/plugins/runner-main.ts --bun /usr/local/bin/bun --data /var/lib/aphelion-plugins
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--bun` | The Bun that runs the runner | The Bun binary that starts each plugin. |
| `--data` | `/var/lib/aphelion-plugins` | The folder that holds one data folder per plugin. |

The runner logs to its standard error. When the server stops, the host tells the runner to stop every plugin. When the pipe closes, the runner kills every plugin and exits.

The container image adds the user, the runner and the data volume in issue [#14](https://github.com/jcore9/Aphelion/issues/14).
