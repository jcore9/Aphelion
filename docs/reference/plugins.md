# Running plugins on the server

A plugin's server part runs on the server as its own process. Two pieces run it:

- The **plugin host** lives inside the server. It reads each plugin's manifest, decides what the plugin may do, and talks to the plugin.
- The **plugin runner** is a separate small program that runs as the `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)). It starts and stops plugin processes, and passes messages between them and the host. It decides nothing.

The host and the runner talk over a pipe that the container's init creates before it drops privileges ([decision 0022](../decisions/0022-bot-network-boundary.md)). The server never signals a plugin process or reads `/proc` itself. It asks the runner.

A plugin with only a client part has no process. The host starts nothing for it ([decision 0042](../decisions/0042-plugin-server-and-client-parts.md)).

The code is in [`apps/server/src/plugins/`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/plugins/). The runner's process handling is in [`apps/server/src/adapters/plugin-processes.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/adapters/plugin-processes.ts).

## For plugin authors

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

Your plugin gets no network proxy yet. See [Permissions](#permissions).

Your data folder is `/var/lib/aphelion-plugins/<id>/`. The runner creates it with mode `0700`. It is the one place your plugin should write.

### Talking to the host

Your plugin talks to the host in [JSON-RPC 2.0](https://www.jsonrpc.org/specification). JSON-RPC is a small format for requests, replies and one-way notifications in JSON. Each message is one line of JSON:

- The host writes to your plugin's standard input.
- Your plugin writes to its standard output.
- A line can be at most 1 MiB. The runner drops a longer line and logs that it did.
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
- It stops reading its standard input, or it writes faster than the host can handle. See [Talking to the host](#talking-to-the-host).

The restarts after the first five crashes in a row wait 1, 2, 4, 8 and 16 seconds. After the sixth crash in a row, the host stops the plugin and doesn't restart it. A run that stays up for 60 seconds or more resets the count.

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
| `stopping` | The host sent `shutdown` and waits 5 seconds before the runner kills the plugin. A plugin that is still starting is killed at once. |
| `crashed` | The plugin crashed. The host restarts it after the wait in [Crashes and restarts](#crashes-and-restarts). |
| `stopped` | The plugin was stopped on request, or it crashed too often. |

Each start gets a new run number. Every message between the host and the runner carries it, so a late message from a killed process can't change the state of the new one. Each timer also has a purpose (the `initialize` deadline, the shutdown grace time, or the restart wait). A timer counts only in the state that set it. For example, the `initialize` deadline can't cut the shutdown grace time short.

### Permissions

A plugin gets an event only if both are true:

- Its manifest asks for it.
- The owner granted it.

Grants come from issue [#101](https://github.com/jcore9/Aphelion/issues/101), which isn't built yet. Until then the host grants nothing. Plugins start and run, but they get no events.

Plugins get no network proxy, even for hosts in `permissions.network`. One shared proxy address would show any password in it to every plugin, and the proxy can't yet tell one plugin from another. Issue [#101](https://github.com/jcore9/Aphelion/issues/101) brings network access back, with a way for the proxy to know which plugin is asking. This is the safe default until the owner decides.

### Isolation between plugins

Every server plugin runs as the same `aphelion-plugins` user ([decision 0018](../decisions/0018-shared-plugin-user.md)), with Docker's default seccomp profile and no namespaces of its own ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)). The host's permission checks keep plugins apart. The operating system doesn't. One plugin can read another plugin's data folder and send signals to its processes. Install only plugins you trust.

The runner also runs as `aphelion-plugins`, so a plugin can send signals to the runner too. When the runner dies, its pipe closes, and the host logs `the plugin runner's pipe closed`.

### What the runner relies on

The runner trusts every message on its standard input. Only the server may write there. The runner protects its pipe in two ways:

- The runner marks itself as not dumpable with `prctl(PR_SET_DUMPABLE, 0)`. Linux then hides the runner's memory and open files from other processes of the same user. A plugin can't open the runner's pipe through `/proc/<runner>/fd/` or attach a debugger to the runner. A test checks that a process of the same user can't read where `/proc/<runner>/fd/0` points, which Linux refuses for the same reason it refuses opening it.
- The runner gives each plugin new pipes for its standard input, output and error. A plugin doesn't inherit the runner's pipe.

Issue [#14](https://github.com/jcore9/Aphelion/issues/14), the container image, must make sure of the rest:

- The init creates the pipe before it drops privileges, and only the server and the runner hold its ends.
- No file in the filesystem leads to the pipe, and no other process gets a copy of its ends.
- The `aphelion-plugins` user can't open, signal or debug the server.

### Running the runner

The container's init starts the runner as `aphelion-plugins`, with the pipe to the server on its standard input and output:

```sh
bun apps/server/src/plugins/runner-main.ts --bun /usr/local/bin/bun --data /var/lib/aphelion-plugins
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--bun` | The Bun that runs the runner | The Bun binary that starts each plugin. |
| `--data` | `/var/lib/aphelion-plugins` | The folder that holds one data folder per plugin. |

The runner logs to its standard error. It logs an error if it couldn't kill every process of a plugin. When the server stops, the host tells the runner to stop every plugin. When the pipe closes, the runner kills every plugin and exits.

The container image adds the user, the runner and the data volume in issue [#14](https://github.com/jcore9/Aphelion/issues/14).
