# The host command

`aphelion` on the host is a root-only script, [`deploy/host/aphelion`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/aphelion). It runs the Docker steps of the [install guide](../guides/install.md) for you, so you type no Docker words. [`deploy/host/install`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/install) links it to `/usr/local/bin/aphelion`, a folder on root's PATH, which is the list of folders the shell searches for commands.

It is not the server's [`aphelion` command](cli.md). That one runs inside the container. The host command runs it for the `device` and `tool` commands.

## Commands

| Command | What it does |
| --- | --- |
| `sudo aphelion status` | Shows the service, the container, `/health` and each installed AI tool |
| `sudo aphelion device add NAME [--days N]` | Adds a device and prints its token. The token is the only line on standard output. |
| `sudo aphelion device list` | Lists the devices |
| `sudo aphelion device revoke ID` | Stops a device's token at once |
| `sudo aphelion tool list` | Lists the AI tools Aphelion can install and whether each is installed |
| `sudo aphelion tool install NAME` | Downloads an AI tool from the list, checks it and installs it |
| `sudo aphelion tool remove NAME` | Removes an installed AI tool |
| `sudo aphelion check` | Runs every check the host can run alone |
| `aphelion --help` | Prints the commands. Works without `sudo`. |

Run any other command without root, and it prints `Run it with sudo: sudo aphelion <what you typed>` and exits with status 2. An unknown command, or a command with the wrong number of words, prints the usage and exits with status 2.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command worked. For `status`, the service runs and `/health` answers. For `check`, every check passed. |
| 1 | `status` found the service or `/health` down. `check` found a failed check. |
| 2 | The command was misused, or it wasn't run as root. |

A `device` or `tool` command exits with the code of the server's own `aphelion device` or `aphelion tool` command, which [the aphelion command](cli.md#exit-codes) lists.

## `status`

```text
service: enabled, running
container: running
health: ok
claude: signed in
codex: not signed in, or the check failed
grok: installed, sign-in state unknown
```

- `service` comes from `systemctl is-enabled aphelion` and `systemctl is-active aphelion`.
- `container` comes from `docker compose ps`.
- `health` asks `http://ADDRESS:7400/health` from the host. `ADDRESS` is `APHELION_TAILNET_ADDRESS` in `/opt/aphelion/deploy/.env`.
- The AI tool lines come from [`aphelion tool list`](cli.md#aphelion-tool-list). They list only tools with the state `installed`. With none installed, the line is `AI tools: none installed`. With the container stopped, it is `AI tools: unknown, the container isn't running`.

For each installed tool that has a status command, Aphelion runs that command as `aphelion-bot` and keeps only whether it exited with 0 ([decision 0019](../decisions/0019-cli-subscription-use.md)). It never prints the command's output. A tool whose status command is `-` shows `<name>: installed, sign-in state unknown`.

| Tool | Status command | Shown when signed in |
| --- | --- | --- |
| `claude` | `claude auth status --text` | `claude: signed in` |
| `codex` | `codex login status` | `codex: signed in` |
| `grok`, `opencode` | none that is reliable | `<name>: installed, sign-in state unknown` |

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
| The firewall chains exist | `iptables -t mangle -S` finds `APHELION-FORWARD` and `APHELION-INPUT` |
| The processor has `sse4_2` | `/proc/cpuinfo` lists it. Only on x86-64, because Bun needs it. |

`check` doesn't run what needs a second machine, a reboot, a bot or a key. That leaves out the WebSocket sign-in, which would make a device token, and [`host/network-check`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/network-check), which needs addresses to test.

## Settings

Both settings are for tests. You don't need them on a real host.

| Variable | Default | Meaning |
| --- | --- | --- |
| `APHELION_DEPLOY` | `/opt/aphelion/deploy` | The folder with `compose.yaml` and `.env`. Every Compose call runs with `--project-directory` set to it. |
| `APHELION_CREDENTIAL` | `/etc/credstore.encrypted/aphelion-bootstrap` | The file the credential check looks for |

Compose's own `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE` pass through to every call.

## What it runs underneath

| Command | Runs |
| --- | --- |
| `device …` | `docker compose exec -T --user harness aphelion aphelion device …`, with output and exit code passed through |
| `tool …` | `docker compose exec -T --user harness aphelion aphelion tool …`, with output and exit code passed through |
| `status`, `check` | `systemctl`, `curl`, `iptables -t mangle -S`, `docker compose ps`, `docker inspect`, and for each installed tool `docker compose exec -T --user aphelion-bot aphelion <status command>` |
