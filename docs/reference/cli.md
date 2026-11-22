# The aphelion command

`aphelion` is one program. It starts the server, checks the config, and manages device tokens. In the container it is the compiled binary that the image runs with `--headless` ([decision 0016](../decisions/0016-one-docker-container.md)). The desktop app doesn't bundle it ([decision 0017](../decisions/0017-desktop-remote-only.md)). [Decision 0048](../decisions/0048-cli-on-node-parseargs.md) explains how the command line is read.

## Commands

| Command | What it does |
| --- | --- |
| `aphelion --headless` | Checks the config, then starts the server. The container runs this. |
| `aphelion config check` | Checks the config files, the modes of the config and state folders and, with `--compose`, the ports a Compose file publishes |
| `aphelion device add NAME` | Adds a device and prints its token once |
| `aphelion device list` | Lists the devices and whether each token is active, expired or revoked |
| `aphelion device revoke ID` | Stops a device's token at once |
| `aphelion --version` | Prints `aphelion` and the version, such as `aphelion 0.0.0` |
| `aphelion --help`, or `aphelion` alone | Prints the commands |

### Options

| Option | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `--config-dir DIR` | `--headless`, `config check` | `/etc/aphelion` | The folder with the [config files](config.md) |
| `--state-dir DIR` | `--headless`, `config check`, `device` | `/var/lib/aphelion` | The folder that holds the database, `aphelion.db` |
| `--compose FILE` | `config check` | none | The output of `docker compose config` to check, or `-` to read it from standard input |
| `--days DAYS` | `device add` | `90` | How long the token works, from 1 to 365 days |

The folders match [decision 0014](../decisions/0014-filesystem-layout.md). Pass other folders on a developer's machine. An option that a command doesn't use is an error, and so is an option given twice or given an empty value. A mistyped command never runs with an option silently ignored or replaced. `--help` anywhere on the line prints the commands and ignores the rest. An error message never repeats the words you typed after the command, so a token pasted by mistake doesn't end up in a log.

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

On `SIGTERM` or `SIGINT` it logs `server stopping`, closes the listener and the database, and exits with code 130.

The server logs JSON lines on standard output, through the redacting [logger](logging.md). A start looks like this:

```
{"time":"2026-11-22T22:30:55.188Z","level":"info","msg":"server started","version":"0.0.0","address":"0.0.0.0","port":7400}
```

Headless mode never loads Electron or any GUI library. The plugin host doesn't start with the server yet. [#14](https://github.com/jcore9/Aphelion/issues/14) adds it with the container.

## `aphelion config check`

The check prints one line for each problem it finds. It looks at:

- the owner and mode of the config folder and each file ([owners and modes](config.md#owners-and-modes));
- the owner and mode of the state folder. It must be a folder owned by the server's user and group, with a mode no looser than `0700`;
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

With `--compose`, the check also runs [the Compose port rule](server.md#the-compose-port-rule) on the Compose file. Every port that any service publishes must be on a tailnet address, in `100.64.0.0/10`.

The check reads the output of `docker compose config`, not the Compose file itself. That command fills in variables such as `${TAILNET_IP}` and merges override files, so the check sees what Docker will run. The owner decided this on 2026-11-22. Add `--profile '*'` so that services in optional profiles are checked too. Docker Compose 5.8 accepts it.

The container can't run Docker, because it never gets the Docker socket ([decision 0016](../decisions/0016-one-docker-container.md)). So Docker runs on the host, and its output goes to the check in the container through standard input:

```sh
set -o pipefail
docker compose --profile '*' config \
  | docker compose run --rm -T --user harness aphelion aphelion config check --compose -
```

`set -o pipefail` makes the whole line fail when `docker compose config` fails, for example on a syntax error, instead of reporting only the check's result.

The service name and the way the image starts `aphelion` come from the Compose file and image that [#14](https://github.com/jcore9/Aphelion/issues/14) builds, so this line may change there. `--compose FILE` reads a file that holds the same output instead. The check refuses input with no services, such as an empty file or `{}`, because that can't be the output for Aphelion's Compose file.

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

To save the token to a file, create the file so that only you can read it:

```sh
(umask 077 && docker compose exec -T --user harness aphelion aphelion device add laptop > token.txt)
```

If the token can't be printed, for example because the disk is full, the command revokes the new device at once and exits with code 1, so no working token is left that nobody saw.

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

## Building the binary

```sh
cd apps/server
bun run build
```

This runs `bun build --compile` and writes one file, `apps/server/dist/aphelion`, of about 110 MB. The binary holds Bun itself, so the machine that runs it needs nothing else. On a developer's machine, `bun apps/server/src/cli/main.ts` runs the same program from source.

## Code

| File | Holds |
| --- | --- |
| [`apps/server/src/cli/main.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/main.ts) | The entry point of the binary |
| [`apps/server/src/cli/args.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/args.ts) | Reads the command line into one command, and refuses a wrong one |
| [`apps/server/src/cli/index.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/index.ts) | Runs the command, and turns failures into exit codes |
| [`apps/server/src/cli/headless.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/headless.ts) | `--headless` |
| [`apps/server/src/cli/checks.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/checks.ts) | The checks that `--headless` and `config check` share |
| [`apps/server/src/cli/config-check.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/config-check.ts) | `config check` |
| [`apps/server/src/cli/device.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/cli/device.ts) | `device add`, `device list` and `device revoke` |
| [`apps/server/src/adapters/run-main.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/adapters/run-main.ts) | Runs the program on Bun, and stops it on `SIGTERM` or `SIGINT` |
