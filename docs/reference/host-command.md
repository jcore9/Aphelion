# The host command

`aphelion` on the host is a root-only script, [`deploy/host/aphelion`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/aphelion). It runs the Docker steps of the [install guide](../guides/install.md) for you, so you type no Docker words. [`deploy/host/install`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/install) links it to `/usr/local/bin/aphelion`, a folder on root's PATH, which is the list of folders the shell searches for commands.

It is not the server's [`aphelion` command](cli.md). That one runs inside the container. The host command runs it for the `device`, `tool` and `plugin` commands.

## Commands

| Command | What it does |
| --- | --- |
| `sudo aphelion status` | Shows the service, the container, `/health` and each installed AI tool |
| `sudo aphelion logs [--follow] [--lines N] [--since TIME]` | Shows the service logs from `journalctl` |
| `sudo aphelion upgrade [TAG]` | Moves `/opt/aphelion` and the server image to `TAG`, or to the newest published release |
| `sudo aphelion network-check [TARGETS...]` | Checks the firewall rules, Docker's chains and ufw's setting, and with six `IP:PORT` targets probes them from the container |
| `sudo aphelion device add NAME [--days N]` | Adds a device and prints its token. The token is the only line on standard output. |
| `sudo aphelion device list` | Lists the devices |
| `sudo aphelion device revoke ID` | Stops a device's token at once |
| `sudo aphelion tool list` | Lists the AI tools Aphelion can install and whether each is installed |
| `sudo aphelion tool install NAME` | Downloads an AI tool from the list, checks it and installs it |
| `sudo aphelion tool update [NAME]` | Moves an installed AI tool, or every installed one, to the version the list pins |
| `sudo aphelion tool check` | Asks each AI tool's vendor for its newest version |
| `sudo aphelion tool remove NAME` | Removes an installed AI tool |
| `sudo aphelion sign-in NAME` | Signs in to an installed AI tool, on your terminal |
| `sudo aphelion backup [--to FOLDER]` | Stops the service, packs the six volumes into a new folder, starts the service and checks the archive |
| `sudo aphelion restore [PATH]` | Puts a backup into new volumes, finishes the restore and starts the service |
| `sudo aphelion plugin install FOLDER [--approve DIGEST]` | Copies a plugin folder into the container, then previews or approves it |
| `sudo aphelion plugin update ID [--approve DIGEST]` | Updates a plugin from its GitHub releases |
| `sudo aphelion plugin enable ID [--approve DIGEST]` | Switches a plugin on |
| `sudo aphelion plugin rollback ID` | Goes back to the plugin's earlier version |
| `sudo aphelion plugin restart ID` | Restarts a plugin |
| `sudo aphelion plugin dev FOLDER` | Reloads a plugin from a folder in the container after each edit, until you press Ctrl-C |
| `sudo aphelion check` | Runs every check the host can run alone |
| `aphelion --help` | Prints the commands. Works without `sudo`. |

Run any other command without root, and it prints `Run it with sudo: sudo aphelion <what you typed>` and exits with status 2. An unknown command, or a command with the wrong number of words, prints the usage and exits with status 2.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command worked. For `status`, the service runs and `/health` answers. For `check` and `network-check`, every check passed. |
| 1 | `status` found the service or `/health` down. `check` or `network-check` found a failed check. `upgrade` refused or a step failed. |
| 2 | The command was misused, or it wasn't run as root. For `network-check` with six targets, also when a target is malformed, the host can't reach a target, or the container isn't running. |

A `device`, `tool` or `plugin` command exits with the code of the server's own command, which [the aphelion command](cli.md#exit-codes) lists. `logs` exits with `journalctl`'s code. `sign-in` exits with the code of the tool's own sign-in. `sign-in`, `backup`, `restore` and `upgrade` exit with 1 when they refuse or a step fails. `plugin install` exits with 1 when it refuses.

## `status`

```text
service: enabled, running
container: running
health: ok
claude: signed in (update available: 2.1.330 -> 2.1.332)
codex: not signed in, or the check failed
grok: installed, sign-in state unknown
```

- `service` comes from `systemctl is-enabled aphelion` and `systemctl is-active aphelion`.
- `container` comes from `docker compose ps`.
- `health` asks `http://ADDRESS:7400/health` from the host. `ADDRESS` is `APHELION_TAILNET_ADDRESS` in `/opt/aphelion/deploy/.env`.
- The AI tool lines come from [`aphelion tool list`](cli.md#aphelion-tool-list). They list only tools with the state `installed` or `update available`. A tool with an update ends with `(update available: INSTALLED -> PINNED)`, the installed version and the version the list pins. [`tool update`](cli.md#aphelion-tool-update-name) applies it. With none installed, the line is `AI tools: none installed`. With the container stopped, it is `AI tools: unknown, the container isn't running`.

For each installed tool that has a status command, Aphelion runs that command as `aphelion-bot` and keeps only whether it exited with 0 ([decision 0019](../decisions/0019-cli-subscription-use.md)). It never prints the command's output. A tool whose status command is `-` shows `<name>: installed, sign-in state unknown`.

| Tool | Status command | Shown when signed in |
| --- | --- | --- |
| `claude` | `claude auth status --text` | `claude: signed in` |
| `codex` | `codex login status` | `codex: signed in` |
| `grok`, `opencode` | none that is reliable | `<name>: installed, sign-in state unknown` |

## `logs`

`sudo aphelion logs [--follow] [--lines N] [--since TIME]` runs `journalctl -u aphelion --no-pager` and passes through the validated flags:

- `--follow` streams new log entries until you stop it.
- `--lines N` prints the last `N` lines. `N` must be a positive whole number.
- `--since TIME` passes `TIME` as one argument to `journalctl --since`. `TIME` must be non-empty.

Unknown flags or invalid values print usage and exit with 2. The command never reads or prints `deploy/.env` or the bootstrap credential.

## `upgrade`

`sudo aphelion upgrade [TAG]` moves the host checkout and server image to `TAG`. With no `TAG`, it reads GitHub's releases API for `jcore9/Aphelion` and picks the newest release that isn't a draft. That includes pre-releases while Aphelion is before v1.0. In order, it does these steps:

1. Checks `/opt/aphelion`, the parent of `$APHELION_DEPLOY`. It refuses a symbolic link for `/opt/aphelion` or `/opt/aphelion/.git`, any file that root doesn't own or that others can write, or local changes checked with `git --no-optional-locks status --porcelain`.
2. Compares `HEAD` with `refs/tags/TAG^{commit}`. If they differ, it fetches tags with `git fetch --tags`, stops if `refs/tags/TAG` doesn't exist, and checks out `refs/tags/TAG` detached.
3. Runs [`deploy/host/get-image`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/get-image) `TAG` from the checked-out release. That script downloads `aphelion-image.sha256` from the release, checks that the file holds one `ghcr.io/jcore9/aphelion@sha256:<64 hex characters>` line, pulls the image by that digest, checks `RepoDigests`, and tags it as `aphelion:local`. If `aphelion:local` already carries that digest, it changes nothing. If the release has no digest file or `docker pull` fails, for example while the `ghcr.io` package stays private, it builds `aphelion:local` with `docker compose build`.
4. Runs [`deploy/host/install`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/install) to update the service file and link while keeping the bootstrap key. If step 3 or step 4 fails after step 2 moved the checkout, `upgrade` puts `/opt/aphelion` back on its earlier branch or commit and leaves `aphelion:local` unchanged.
5. Restarts `aphelion.service`, prints `Upgraded Aphelion from BEFORE to AFTER.`, waits up to 30 seconds for `/health`, and runs `aphelion check`.

## `network-check`

`sudo aphelion network-check [TARGETS...]` runs [`deploy/host/network-check`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/network-check).

With no arguments, it runs only the read-only firewall check:

- `APHELION-FORWARD` and `APHELION-INPUT` exist in the IPv4 `mangle` table.
- `FORWARD` jumps to `APHELION-FORWARD`, and `INPUT` jumps to `APHELION-INPUT` (`iptables -C`).
- Every rule installed by `deploy/host/firewall` exists in `APHELION-FORWARD` and `APHELION-INPUT` (`iptables -C`).
- When IPv6 `mangle` is available, the three `aphelion0` `DROP` rules exist in `INPUT` and `FORWARD` (`ip6tables -C`).
- Docker's `DOCKER` chain exists in the `filter` and `nat` tables.
- `/etc/default/ufw` and `/etc/ufw/ufw.conf` don't have ufw enabled with `MANAGE_BUILTINS=yes`.

Each missing chain or rule prints a `FAIL` line naming it, followed by the recovery commands.

With six `IP:PORT` targets, it runs the firewall check first, verifies the host reaches each target, then probes the first five targets (must time out), the sixth target (must connect), and DNS (`getent hosts api.anthropic.com`) as `aphelion-bot` inside the running container.

## `sign-in`

`sudo aphelion sign-in NAME` signs in to the AI tool `NAME`, as the `aphelion-bot` user, with the tool's own sign-in command. It reads that command from the `SIGN-IN-COMMAND` column of [`aphelion tool list`](cli.md#aphelion-tool-list), so the list in `deploy/ai-tools.json` stays the one source.

- It refuses a name that isn't on the list, and a tool that isn't installed, and names the command that installs it. It also refuses when the list gives no sign-in command for the tool, which means the image is older than the command.
- It refuses without a terminal, on standard input or standard output, with `sign-in needs a terminal. Run it in a shell on the host, not through a pipe or a script.`
- The tool talks to your terminal directly. Aphelion doesn't capture or log what it prints, such as a code or a token ([decision 0019](../decisions/0019-cli-subscription-use.md)).

## `backup`

`sudo aphelion backup [--to FOLDER]` makes one backup and prints its folder. `FOLDER` defaults to `$APHELION_BACKUP_DIR`. A folder that exists keeps its mode; a new one is created with mode 0700. In order, it:

1. Stops the service, if it runs. It starts the service again at the end, and also when a step fails.
2. Packs the six volumes, read-only, in a short-lived container made from the service's own image. The folder is `aphelion-backup-YYYYMMDD-HHMMSS`, and only root can read it. It holds `aphelion-data.tar.gz` and `aphelion-data.tar.gz.sha256`.
3. Checks the archive against its checksum, and tests that it unpacks as gzip.
4. Points `latest` at the new folder with one atomic rename, and only then deletes the backups before the previous one. A backup that fails removes its own folder and leaves `latest` and the earlier backups alone.

It doesn't copy the backup off the host. [Back up](../guides/install.md#back-up) shows the `ssh` command.

## `restore`

`sudo aphelion restore [PATH]` puts a backup into new volumes. `PATH` is a backup folder or an archive file, and defaults to `latest` in `$APHELION_BACKUP_DIR`. In order, it:

1. Checks the archive against its `.sha256` file. A missing file, a mismatch, or an entry that names another file stops it before it changes anything.
2. Stops the service, if it runs, and says so.
3. Refuses if any of the six volumes exists, or if `docker volume ls` fails, and prints the commands that remove them. It never removes a volume itself.
4. Creates the six volumes with the Compose labels, and unpacks the archive into them.
5. Runs [`aphelion restore finish`](cli.md#aphelion-restore-finish) as `harness` in a short-lived container, and prints its output.
6. Starts the service only if step 5 exited with 0. Otherwise it leaves the service stopped, says so, and prints the commands that remove the volumes, so you can start over.

## `plugin install`

`sudo aphelion plugin install FOLDER [--approve DIGEST]` takes a folder on the host. The folder's name becomes the plugin's name in the container, so it can hold only letters, digits, dots, dashes and underscores, and must start with a letter or digit. `@` isn't allowed. The folder can't be a symbolic link, and the container must be running.

- Without `--approve`, it refuses a plugin that is already in `/opt/aphelion/plugins`. Otherwise it copies the folder in with `docker compose cp` and runs the server's preview.
- With `--approve`, it doesn't copy again. It runs the server's approval on the folder that is in the container, and, when that works, prints `sudo systemctl restart aphelion` as the next step.

## `check`

`check` prints one line per check, then how many passed. It exits with 0 only when every check passed.

```text
ok    the service is enabled and running
FAIL  the bootstrap credential exists: /etc/credstore.encrypted/aphelion-bootstrap is missing. Run host/install.
6 of 7 checks passed
```

| Check | Passes when |
| --- | --- |
| The service is enabled and running | `systemctl` reports `enabled` and `active` for `aphelion` |
| The container is running | `docker compose ps` lists a running `aphelion` container |
| `/health` answers on the tailnet address | The host gets `{"status":"ok"}` |
| `config check` accepts the Compose file | `aphelion config check --compose -` passes on the rendered Compose file, as [`host/preflight`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/preflight) runs it |
| The container is hardened | `docker inspect` shows a read-only root, `no-new-privileges`, no privileged mode, all capabilities dropped except `SETUID`, `SETGID` and `KILL`, and no Docker socket |
| The bootstrap credential exists | `/etc/credstore.encrypted/aphelion-bootstrap` is a file |
| The firewall chains exist | The read-only check in `aphelion network-check` passes: `APHELION-FORWARD` and `APHELION-INPUT` chains and rules, their `FORWARD` and `INPUT` jumps, IPv6 drop rules, Docker's `filter` and `nat` `DOCKER` chains, and ufw's `MANAGE_BUILTINS` setting |
| The processor has `sse4_2` | `/proc/cpuinfo` lists it. Only on x86-64, because Bun needs it. |

`check` doesn't run what needs a second machine, a reboot, a bot or a key. That leaves out the WebSocket sign-in, which would make a device token, and the six active probes in `aphelion network-check`, which need addresses to test.

## Settings

These settings are for tests, and for a backup folder on another disk. You don't need them otherwise.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APHELION_BACKUP_DIR` | `/var/backups/aphelion` | The folder that `backup` writes into and `restore` reads `latest` from |
| `APHELION_DEPLOY` | `/opt/aphelion/deploy` | The folder with `compose.yaml` and `.env`. Every Compose call runs with `--project-directory` set to it. |
| `APHELION_CREDENTIAL` | `/etc/credstore.encrypted/aphelion-bootstrap` | The file the credential check looks for |

Compose's own `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE` pass through to every call. `backup` and `restore` take the volume names from `COMPOSE_PROJECT_NAME`, which is `aphelion` when unset.

## What it runs underneath

| Command | Runs |
| --- | --- |
| `device …` | `docker compose exec -T --user harness aphelion aphelion device …`, with output and exit code passed through |
| `tool …` | `docker compose exec -T --user harness aphelion aphelion tool …`, with output and exit code passed through |
| `plugin dev …` | `docker compose exec --user harness aphelion aphelion plugin dev …`, without `-T`, so Ctrl-C stops it |
| `plugin install FOLDER` | `docker compose cp FOLDER aphelion:/opt/aphelion/plugins/NAME`, then `docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/plugins/NAME …` |
| `plugin …` (other) | `docker compose exec -T --user harness aphelion aphelion plugin …`, with output and exit code passed through |
| `sign-in NAME` | `docker compose exec --user aphelion-bot aphelion <the tool's sign-in command>`, attached to your terminal |
| `backup`, `restore` | `systemctl`, `docker compose config --images`, `docker volume`, and `docker run` for the packing, the unpacking and `aphelion restore finish`. [Back up](../guides/install.md#back-up) and [Restore on the new host](../guides/install.md#restore-on-the-new-host) list them. |
| `logs` | `journalctl -u aphelion --no-pager`, with validated `--follow`, `--lines` and `--since` flags |
| `upgrade [TAG]` | `git`, `curl`, [`deploy/host/get-image`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/get-image), [`deploy/host/install`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/install), `systemctl restart aphelion`, and `aphelion check` |
| `network-check [TARGETS...]` | [`deploy/host/network-check`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/network-check): `iptables`, `ip6tables`, reading `/etc/default/ufw` and `/etc/ufw/ufw.conf`, and with six targets `docker compose exec -T --user aphelion-bot aphelion …` |
| `status`, `check` | `systemctl`, `curl`, `deploy/host/network-check` (`iptables`, `ip6tables` and ufw config), `docker compose ps`, `docker inspect`, and for each installed tool `docker compose exec -T --user aphelion-bot aphelion <status command>` |
