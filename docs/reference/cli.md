# The aphelion command

`aphelion` is one program. It starts the server, checks the config, and manages device tokens. In the container it is the compiled binary that the image runs with `--headless` ([decision 0016](../decisions/0016-one-docker-container.md)). The desktop app doesn't bundle it ([decision 0017](../decisions/0017-desktop-remote-only.md)). [Decision 0067](../decisions/0067-cli-on-effect-cli.md) explains how the command line is read. On the host, [`sudo aphelion`](host-command.md) runs the `device` commands inside the container for you.

## Commands

| Command | What it does |
| --- | --- |
| `aphelion --headless` | Checks the config, then starts the server. The container runs this. |
| `aphelion config check` | Checks the config files, the modes of the config and state folders and, with `--compose`, the ports a Docker Compose file publishes |
| `aphelion restore finish` | Run once after restoring a backup, before the server starts. Revokes every device token and switches every plugin off. |
| `aphelion plugin enable ID` | Switches plugin `ID` back on after a restore switched it off, and with `--approve` restarts it |
| `aphelion plugin update ID` | Previews the latest GitHub release of plugin `ID`, and with `--approve` installs it and restarts the plugin on it |
| `aphelion plugin rollback ID` | Goes back to the version of plugin `ID` before the current one, and restarts the plugin on it |
| `aphelion plugin restart ID` | Asks the running server to restart plugin `ID` on its approved version |
| `aphelion plugin dev FOLDER` | Reloads the approved plugin in `FOLDER` through the running server, and again after each change to the folder. Works only in [dev mode](plugins.md#dev-mode). |
| `aphelion tool list` | Lists the AI tools on Aphelion's list and whether each is installed |
| `aphelion tool install NAME` | Downloads an AI tool from the list, checks it and installs it |
| `aphelion tool update [NAME]` | Moves an installed AI tool, or every installed AI tool, to the version the list pins |
| `aphelion tool check` | Asks each AI tool's vendor for its newest version and compares it with the list's |
| `aphelion tool remove NAME` | Removes an installed AI tool |
| `aphelion device add NAME` | Adds a device and prints its token once |
| `aphelion device list` | Lists the devices and whether each token is active, expired or revoked |
| `aphelion device revoke ID` | Stops a device's token at once |
| `aphelion --version`, or `-v` | Prints `aphelion` and the version, such as `aphelion 0.1.0-alpha.1` |
| `aphelion --help`, or `aphelion` alone | Prints the command groups. `aphelion GROUP --help` lists the commands in a group, and `aphelion GROUP COMMAND --help` shows that command's options and defaults. |

### Options

| Option | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `--config-dir DIR` | `--headless`, `config check` | `/etc/aphelion` | The folder with the [config files](config.md) |
| `--state-dir DIR` | `--headless`, `config check`, `plugin`, `device`, `restore`, `tool install`, `tool remove` | `/var/lib/aphelion` | The folder that holds the database, `aphelion.db` |
| `--plugins-dir DIR` | `plugin install`, `plugin update`, `plugin rollback` | `/opt/aphelion/plugins` | An absolute path. The folder where updates put each release, as `<id>@<version>`. `plugin install` refuses a folder there that updates manage. |
| `--tools-dir DIR` | `tool` | `/opt/aphelion/tools` | An absolute path. The folder that holds the installed AI tools. |
| `--approve DIGEST` | `plugin install`, `plugin update`, `plugin enable` | none | The value the preview printed. It approves exactly what the preview showed. |
| `--compose FILE` | `config check` | none | The output of `docker compose config` to check, or `-` to read it from standard input |
| `--days DAYS` | `device add` | `90` | How long the token works, from 1 to 365 days |
| `--plugin-runner-fds REPLIES,REQUESTS` | `--headless` | none | The two file descriptors of the plugin runner's pipes, from 3 up. The server reads the runner's replies on `REPLIES` and writes its requests on `REQUESTS`. |
| `--plugin-dev FOLDER` | `--headless` | none | An absolute path. Turns on [dev mode](plugins.md#dev-mode): `plugin dev` can reload the approved plugin in `FOLDER` through the server's [control socket](plugins.md#control-socket). Needs `--plugin-runner-fds` to have any effect. |

The folders match [decision 0014](../decisions/0014-filesystem-layout.md). Pass other folders on a developer's machine. Write each option after the command, as in `aphelion device list --state-dir /s`. An option before the command is an error. An option that a command doesn't use is an error, and so is an option given twice or given an empty value. A mistyped command never runs with an option silently ignored or replaced. `--help` anywhere on the line prints the commands and ignores the rest. An error message never repeats the words you typed after the command, so a token pasted by mistake doesn't end up in a log.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded |
| `1` | The check found problems, the server couldn't start, or the command failed. The reason is printed. |
| `2` | The command line is wrong, for example an unknown command or a missing name |
| `130` | The server stopped because it was sent `SIGTERM` or `SIGINT`, as `docker stop` and Ctrl-C do |

## `aphelion --headless`

The server starts in this order:

1. It runs the same checks as `config check`, except the Compose check. If any fails, it logs one `error` line that lists every problem, and exits with code 1. It never starts with a config that bots could read or change.
2. It logs a `warn` line for each config file at an older version, which it read through a migration ([versions and migrations](config.md#versions-and-migrations)).
3. It opens `aphelion.db` in the state folder and applies any new [migrations](store.md#migrations).
4. It starts the [HTTP and WebSocket server](server.md) on the address and port from `server.yaml`, and logs `server started` with the version, address and port.
5. With `--plugin-runner-fds`, it starts the [plugin host](plugins.md) on those pipes and asks the runner to start every plugin that `aphelion plugin install` approved. It logs an `error` line for a plugin that fails a check, and goes on with the others. A plugin fails when the server can't read its manifest, or when its files, version or permissions no longer match the approved version. Then the server logs `plugin host started` with the number of approved plugins, and opens the [control socket](plugins.md#control-socket). Without the option, it logs `plugins are off: no plugin runner pipe was given`.

On `SIGTERM` or `SIGINT` it logs `server stopping`, closes the listener and the database, and exits with code 130.

The server logs JSON lines on standard output, through the redacting [logger](logging.md). A start looks like this:

```
{"time":"2026-11-22T22:30:55.188Z","level":"info","msg":"server started","version":"0.1.0-alpha.1","address":"0.0.0.0","port":7400}
```

Headless mode never loads Electron or any GUI library. In the container, the [launcher](container.md#how-the-processes-start) creates the pipes and passes `--plugin-runner-fds 3,4`, and `--plugin-dev` when `APHELION_PLUGIN_DEV_FOLDER` is set and not empty.

## `aphelion config check`

The check prints one line for each problem it finds. It looks at:

- the owner and mode of the config folder and each file ([owners and modes](config.md#owners-and-modes)).
- the owner and mode of the state folder. It must be a folder owned by the server's user and group, with a mode no looser than `0700`.
- the five config files, as `loadConfig` reads them ([config errors](config.md#errors)).

It reads the config files only when every owner and mode is right. A path that isn't a regular file, such as a named pipe, could make the read wait forever, so the check stops before reading it.

The server's user and group are the ones that run the command. Run it as the server's user, `harness` in the container, or the owner check fails.

A clean run prints one line:

```
Config OK. The Compose file wasn't checked: pass --compose to check it.
```

A run with problems prints each one, then the count on standard error, and exits with code 1:

```
/etc/aphelion: has mode 0755, which is looser than 0750
/var/lib/aphelion: has mode 0750, which is looser than 0700
2 problems found.
```

### Checking the Compose file

With `--compose`, the check also runs [the Compose port rule](server.md#the-compose-port-rule) on the Compose file. Every port that any service publishes must be on a tailnet address in `100.64.0.0/10`. A tailnet is the owner's private Tailscale network.

It also checks that a published port can reach the server ([decision 0055](../decisions/0055-compose-check-server-listener.md)):

- `address` in `server.yaml` must be `0.0.0.0`. Compose forwards connections to the container's own network interface, and a server on `127.0.0.1` never sees them.
- `port` in `server.yaml` must be `7400`, the only port that the [host firewall](container.md#network) lets into the container.
- Every port that the `aphelion` service publishes must forward to the server's TCP port. The first number, the host port, may differ. `"100.71.226.67:8443:7400"` passes. A service that publishes no port passes this rule.

Without `--compose`, any valid address and port pass, so the server can run from source on `127.0.0.1`. A check of a `server.yaml` with `address: 127.0.0.1` and `port: 7401` against the shipped Compose file prints:

```
/etc/aphelion/server.yaml: address: is 127.0.0.1. With --compose it must be 0.0.0.0, so a published port can reach the server inside the container.
/etc/aphelion/server.yaml: port: is 7401. With --compose it must be 7400, the port the host firewall opens.
compose (stdin):58:9: services.aphelion.ports[0]: forwards to container port 7400, but it must forward to TCP port 7401, the server's port in server.yaml.
3 problems found.
```

The check reads the output of `docker compose config`, not the Compose file itself. That command fills in variables such as `${TAILNET_IP}` and merges override files, so the check sees what Docker will run. The owner decided this on 2026-11-22. Add `--profile '*'` so that services in optional profiles are checked too. Docker Compose 5.8 accepts it.

The container can't run Docker, because it never gets the Docker socket ([decision 0016](../decisions/0016-one-docker-container.md)). So Docker runs on the host, and its output goes to the check in the container through standard input:

```sh
set -o pipefail
docker compose --profile '*' config \
  | docker compose run --rm -T --user harness aphelion aphelion config check --compose -
```

`set -o pipefail` makes the whole line fail when `docker compose config` fails, for example on a syntax error, instead of reporting only the check's result.

`docker compose run` mounts the bootstrap key that `aphelion.service` decrypts, so the line works only while the service runs. When the service is stopped, the run fails because the key file doesn't exist. The service runs the line itself before every start.

The service is named `aphelion` in [`deploy/compose.yaml`](https://github.com/jcore9/Aphelion/blob/main/deploy/compose.yaml), and `aphelion.service` runs this line before every start ([what the service does](../guides/install.md#what-the-service-does)). `--compose FILE` reads a file that holds the same output instead. The check refuses input with no services, such as an empty file or `{}`, because that can't be the output for Aphelion's Compose file.

## `aphelion plugin dev FOLDER`

```sh
aphelion plugin dev FOLDER [--state-dir DIR]
```

Reloads a plugin while you work on it. The server must run with `--plugin-dev FOLDER`, and `FOLDER` must already be approved with `aphelion plugin install`. [Write your first server plugin](../guides/write-your-first-server-plugin.md) shows the whole path.

The command connects to the [control socket](plugins.md#control-socket), `plugin-control.sock` in the state folder. It asks the server to reload the plugin, then checks the folder about every half second, and asks again after each change has settled. It prints one line for each answer, as soon as the answer arrives:

| Line | Meaning |
| --- | --- |
| `Watching FOLDER. Press Ctrl-C to stop watching. The plugin keeps running.` | The command is connected. Standard output. |
| `Reloaded ID: the handshake finished.` | The server started a new run of plugin `ID` and the plugin answered `initialize`. Standard output. |
| `Reloaded ID, but it isn't running: STATE. The server log says why.` | The reload finished in some other state. `crashed` means it exited or the runner refused it. `starting` means it hadn't answered after 15 seconds. Standard error. |
| `ID crashed after the handshake. If its start() failed, the server log says why.` | The run that just finished the handshake crashed before the next reload. A stop you asked for does not print this. Standard error. |
| `Refused: REASON` | The server didn't reload. The reason says why, for example that the folder isn't approved or that the manifest asks for a permission that wasn't granted. The command keeps watching. Standard error. |

The command exits with code 1 and a message if it can't reach the control socket, or if the server runs without `--plugin-dev`. If the server closes the connection, for example when it restarts, the command prints `aphelion: the server closed the control connection` and exits with code 1. Otherwise it runs until you press Ctrl-C. [Dev mode](plugins.md#dev-mode) lists what the server refuses.

## `aphelion restore finish`

```sh
aphelion restore finish [--state-dir DIR]
```

Run it once after the files of a backup are back and before the server starts ([restore on the new host](../guides/install.md#restore-on-the-new-host)). It changes the restored database in one step, so it either does all of it or none:

- It revokes every device token that was still active. `device list` shows those devices as `revoked`, so you know which ones to enroll again. Until you enroll a device, the server answers nothing but `GET /health` ([device tokens](devices.md#after-a-restore)).
- It switches every plugin off. The files, approvals and settings stay. A plugin stays off until you run [`plugin enable`](#aphelion-plugin-enable-id).
- It writes one `restore.finish` row in the [audit log](logging.md#the-audit-log), with the ids of the devices and plugins it changed.

It prints one line for each switched-off plugin, with the command that switches it on, and then the command that enrolls a device:

```text
Restore finished. Every device token is revoked.
Plugin weather is switched off. Switch it on: aphelion plugin enable weather
Enroll a device: aphelion device add NAME
```

Running it again gives the same result. It revokes every active device again, including one enrolled after the first run, because it can't tell a second run from the restore of a newer backup. Revoking is the safe side: a device that should work only needs enrolling again. It exits with code 1 and changes nothing when there is no database in the state folder.

## `aphelion plugin enable ID`

```sh
aphelion plugin enable ID [--approve DIGEST] [--state-dir DIR]
```

Switches plugin `ID` back on after [`restore finish`](#aphelion-restore-finish) switched it off. It works in two steps, as `plugin update` does. Without `--approve`, it prints the permissions the plugin already has and a digest that covers them and the plugin's files. Repeat the command with `--approve` and that digest to switch the plugin on. It then restarts the plugin through the [control socket](plugins.md#control-socket) and prints the same lines as [`plugin restart`](#aphelion-plugin-restart-id), with `Switched on ID` in place of `Restarted ID`. When the server isn't running, the plugin starts when the server does.

| Output | Meaning |
| --- | --- |
| `ID is already switched on. Nothing changed.` | The plugin was on. Nothing is restarted. Exit code 0. |
| `The files in FOLDER changed since they were approved. Review them and run: aphelion plugin install FOLDER` | The files differ from the approved ones. The plugin stays off. Exit code 1. |
| `The approval does not match this plugin's files or permissions. Preview the plugin again.` | The `--approve` value is wrong or the approval changed. Exit code 1. |
| `ID isn't installed.` | No plugin has that id. Exit code 1. |

## `aphelion plugin update ID`

```sh
aphelion plugin update ID [--approve DIGEST] [--state-dir DIR] [--plugins-dir DIR]
```

A plugin that a restore switched off can't update. The command prints `ID is switched off. Switch it on first: aphelion plugin enable ID` on standard error and exits with code 1.

Updates plugin `ID` from the GitHub repository its manifest names. Without `--approve`, the command downloads and checks the latest release, then prints a preview. The preview can clear abandoned staging files and release folders, and leaves installed versions and approvals in place. With the value the preview printed, the command does the same checks again and installs the release. Then it asks the server to restart the plugin through the [control socket](plugins.md#control-socket). [Updates](plugins.md#updates) lists what the command checks and its limits.

| Output | Meaning |
| --- | --- |
| `Plugin ID can update from OLD to NEW.` | The first preview line. Next come the line about the attestation, one `adds` or `drops` line for each changed permission or `No permission changes.`, and the line with the `--approve` value. Standard output, exit code 0. |
| `ID is already on VERSION, the latest release. If the server still runs an older version, run aphelion plugin restart ID.` | Nothing to install. If an earlier `--approve` run was stopped before it restarted the plugin, run [`plugin restart`](#aphelion-plugin-restart-id). Standard output, exit code 0. |
| `Updated ID from OLD to NEW.` | The release is installed. The next line says `ID NEW runs.`, `ID has no server part to restart.`, or `The server isn't running, so ID starts on NEW when the server starts.` Standard output, exit code 0. |
| `ID NEW didn't start (REASON), so Aphelion went back to OLD.` | The new version failed to start or stopped during the 10-second watch. Aphelion tries to restart the old version. If that fails too, Aphelion keeps both versions and their approvals. The next line reports the old version's state. Standard error, exit code 1. |
| `The approval doesn't match this release's files, permissions or the installed version. Preview the update again.` | The `--approve` value is wrong or out of date. Standard error, exit code 1. |
| Any other sentence | A refusal, such as a release whose attestation doesn't match. Standard error, exit code 1. |

The command reads `APHELION_GITHUB_API` for tests only ([testing with a local GitHub](plugins.md#testing-with-a-local-github)).

## `aphelion plugin rollback ID`

```sh
aphelion plugin rollback ID [--state-dir DIR] [--plugins-dir DIR]
```

Refuses a switched-off plugin, as `plugin update` does. Makes the version before the current one current again, restarts the plugin on it, and deletes the version it left. It prints `Went back from ID CURRENT to EARLIER.` and then a line that says how `EARLIER` runs, as `plugin update` does. If the earlier version fails to start or stops during the 10-second watch, Aphelion restores the version it left and keeps both approvals. It prints `ID EARLIER didn't start (REASON), so Aphelion stayed on CURRENT.` followed by the state of `CURRENT` on standard error and exits with code 1. When there is no earlier version, it prints `ID has no earlier version to go back to.` on standard error and exits with code 1.

## `aphelion plugin restart ID`

```sh
aphelion plugin restart ID [--state-dir DIR]
```

Asks the running server, through the [control socket](plugins.md#control-socket), to restart plugin `ID` on the version that is approved now. A plugin that a restore switched off isn't restarted: the command prints `ID is switched off. Switch it on first: aphelion plugin enable ID` on standard error and exits with code 1. Use it when `plugin update` says the plugin is already on the latest release but the server still runs an older one. The server watches the new run for 10 seconds before it answers, as for an update.

| Output | Meaning |
| --- | --- |
| `Restarted ID. It runs.` | The plugin runs on its approved version. Standard output, exit code 0. |
| `Restarted ID, but it isn't running: STATE. The server log says why.` | The run reached another state, such as `crashed`. Standard error, exit code 1. |
| `The server didn't restart ID: REASON.` | The server refused, for example because the plugin isn't installed or its files changed since they were approved. Standard error, exit code 1. |
| `The server isn't running, so ID starts on its approved version when the server starts.` | Nothing to do now. Standard output, exit code 0. |

## `aphelion device add NAME`

Adds a device, and prints its [device token](devices.md) once. The server keeps only a fingerprint of the token, so it can't be shown again. Run it as the server's user, so the database files keep their owner:

```sh
docker compose exec -T --user harness aphelion aphelion device add "my laptop"
```

`-T` keeps standard output and standard error apart. Without it, Docker joins them into one terminal stream.

The token is the only text on standard output. The other lines go to standard error:

```
aph_dev_b9e491d2e2e20b59_…
Added device "my laptop" with id b9e491d2e2e20b59. Its token expires at 2027-02-20T22:29:30.928Z.
The token is shown once. Copy it to the device now: it can't be shown again.
```

To save the token to a file, create a new file that only you can read. `umask 077` gives a new file mode `0600`, and `noclobber` refuses to write into a file that already exists, which could keep a looser mode:

```sh
(umask 077 && set -o noclobber && docker compose exec -T --user harness aphelion aphelion device add laptop > token.txt)
```

If the token can't be printed, for example because the disk is full, the command revokes the new device at once. It then exits with code 1. So no working token exists that nobody saw.

The name is 1 to 64 characters, with no control characters and no spaces at either end. Two devices may share a name.

## `aphelion device list`

Prints one tab-separated line per device, oldest first. The name is in double quotes, so a name with spaces or tabs stays readable:

```
ID	STATUS	EXPIRES	NAME
b9e491d2e2e20b59	active	2027-02-20T22:29:30.928Z	"my laptop"
```

`STATUS` is `active`, `expired` or `revoked`. The list never shows a token.

## `aphelion device revoke ID`

Stops the token of the device with this id. A WebSocket that uses it closes within 5 seconds. It exits with code 1 when no active device has the id. Both outcomes are written to the [audit log](devices.md#what-is-audited).

## `aphelion tool list`

Prints a header line and one tab-separated line per tool on the list. The list is the copy of [`deploy/ai-tools.json`](https://github.com/jcore9/Aphelion/blob/main/deploy/ai-tools.json) that the image ships.

```
NAME	VERSION	INSTALLED	STATE	STATUS-COMMAND
claude	2.1.332	2.1.330	update available	claude auth status --text
codex	0.172.0	0.172.0	installed	codex login status
grok	1.0.92	-	not installed	-
```

`VERSION` is the version the list pins. `INSTALLED` is the version `<tools folder>/<name>/current` points at, or `-` when the tool isn't installed. `STATE` is one of:

| `STATE` | Meaning |
| --- | --- |
| `installed` | The installed version is the pinned version. |
| `update available` | A version is installed, and it isn't the pinned one. [`tool update`](#aphelion-tool-update-name) installs the pinned one. |
| `not installed` | Nothing usable is installed. This includes a `current` link that is missing, points outside the tool's folder or points at a folder that is gone. |
| `unavailable` | The list has no build for this processor. |

`STATUS-COMMAND` is the command that exits with 0 when the tool is signed in, or `-` when Aphelion has none for the tool.

## `aphelion tool install NAME`

Installs the tool `NAME` from the list: `claude`, `codex`, `grok` or `opencode`. The command:

1. Takes the build for this processor. It refuses a name that isn't on the list, and a tool with no build for this processor.
2. Downloads the build into a staging folder in the tools folder. It stops at the size the list gives, and refuses a download that is larger or smaller.
3. Checks the SHA-256 against the list before it unpacks anything. A gzip archive is unpacked with `tar` only if every member is a plain file or folder inside the archive's own folder.
4. Moves the result to `<tools folder>/<name>/<version>/`, sets mode `0755` on the program, and points `<tools folder>/<name>/current` at that folder with one atomic rename. It then deletes the tool's other version folders.

Installing the version that is installed changes nothing. A run that stopped half way leaves only the staging folder or an unused link, and the next run clears them. The command holds the same lock as `plugin install`, and exits with code 1 and says `Another plugin or AI tool change is running. Try again when it finishes.` when another install, update, rollback, tool install or tool remove holds it. It exits with code 1 for every refusal, and prints the reason on standard error.

The image links `/usr/local/bin/<name>` to the program in `current`, so a bot runs the tool by its name.

## `aphelion tool update [NAME]`

Moves an installed tool to the version the list pins. With `NAME` (`claude`, `codex`, `grok` or `opencode`), it updates that tool. Without a name, it goes through every tool on the list in the list's order. It refuses a name that isn't on the list.

For a tool whose state is `update available`, the command installs the pinned version with every check of [`tool install`](#aphelion-tool-install-name): the size cap, the SHA-256 check before anything is unpacked, the archive listing, the atomic switch, and the lock. It then deletes the old version's folder. A tool that isn't installed isn't installed by this command.

It prints one line per tool on standard output:

| Line | Meaning |
| --- | --- |
| `updated NAME FROM -> TO` | The pinned version `TO` is installed in place of `FROM`. |
| `NAME is up to date (VERSION)` | `VERSION` is the pinned version. Nothing changed. |
| `NAME isn't installed` | There is nothing to update. |
| `NAME has no build for this processor` | The list has no download for this processor. |

Running it again changes nothing. It exits with 1 and prints the reason on standard error when a check refuses the download, and then the installed version stays. With no name, a refused tool doesn't stop the others. Each reason starts with the tool's name, and the exit code is 1 when any tool was refused. The command takes the same lock as `tool install`.

## `aphelion tool check`

Asks each tool's vendor for its newest version, and compares it with the version the list pins. It downloads no program: each lookup reads a small version file or release list and gives up after 10 seconds. The lookups run at the same time. Nothing is installed or changed.

```
NAME	PINNED	LATEST	STATE
claude	2.1.330	2.1.332	newer version available
codex	0.172.0	0.172.0	current
grok	1.0.92	-	unknown
opencode	2.4.1	2.4.1	current
A newer version is available. Moving to it needs a new entry in the AI tool list, which you approve. See "Update an AI tool" in the install guide.
```

`STATE` is `current` when the vendor's newest version is the pinned one or older, `newer version available` when it is higher, and `unknown` when the vendor didn't answer or answered something that isn't a version. `LATEST` is `-` for `unknown`, and standard error says why. The last line appears only when some tool has a newer version.

| Tool | Where the newest version comes from |
| --- | --- |
| `claude` | The `latest` file of Claude Code's release channel, `https://downloads.claude.ai/claude-code-releases/latest`. |
| `grok` | The `stable` channel file at `https://x.ai/cli/stable`, and at xAI's Google Cloud address when the first doesn't answer. |
| `codex` | GitHub's `releases/latest` for `openai/codex`, which is the newest release that isn't a prerelease. |
| `opencode` | The highest plain version among the ten newest releases of `anomalyco/opencode`. GitHub's own `latest` mark points at an old release. |

The command exits with 0 when it ran, even when newer versions exist, and with 1 when every vendor lookup failed or the list can't be read. A newer version reaches your server only through a new entry in the list, which the owner approves ([Update an AI tool](../guides/install.md#update-an-ai-tool)).

## `aphelion tool remove NAME`

Deletes `<tools folder>/<name>`. Running it again prints `<name> isn't installed.` and changes nothing. It doesn't touch the tool's sign-in in the `bots` volume.

## Building the binary

```sh
cd apps/server
bun run build
```

This runs `bun build --compile` and writes one file, `apps/server/dist/aphelion`, of about 110 MB. The [container image](container.md) builds it the same way. The binary holds Bun itself, so the machine that runs it needs nothing else. On a developer's machine, `bun apps/server/src/cli/main.ts` runs the same program from source.

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/cli/main.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/main.ts) | The entry point of the binary |
| [`apps/server/src/cli/index.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/index.ts) | Builds the command tree, runs the command, and turns failures into exit codes |
| [`apps/server/src/cli/flags.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/flags.ts) | The options and operands that several commands share, and the Zod checks on values |
| [`apps/server/src/cli/output.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/output.ts) | Prints help, the version and usage errors, with fixed text that never repeats your input |
| [`apps/server/src/cli/headless.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/headless.ts) | `--headless` |
| [`apps/server/src/cli/checks.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/checks.ts) | The checks that `--headless` and `config check` share |
| [`apps/server/src/cli/config-check.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/config-check.ts) | `config check` |
| [`apps/server/src/cli/device.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/cli/device.ts) | `device add`, `device list` and `device revoke` |
| [`apps/server/src/adapters/run-main.ts`](https://github.com/jcore9/Aphelion/blob/main/apps/server/src/adapters/run-main.ts) | Runs the program on Bun, and stops it on `SIGTERM` or `SIGINT` |
