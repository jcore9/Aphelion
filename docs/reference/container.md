# The container

The headless server runs as one Docker container with four users inside ([decision 0016](../decisions/0016-one-docker-container.md)). [`deploy/Dockerfile`](https://github.com/jcore9/Aphelion/blob/dev/deploy/Dockerfile) builds the image, and [`deploy/compose.yaml`](https://github.com/jcore9/Aphelion/blob/dev/deploy/compose.yaml) runs it. [Install the headless server](../guides/install.md) covers the host side.

## What the image holds

The image is built on Ubuntu 26.04 LTS. The Ubuntu and Bun base images are pinned by digest, which is a hash of the exact image.

| Path | What it is |
| --- | --- |
| `/usr/local/bin/aphelion` | The server and its [command](cli.md), compiled with `bun build --compile` |
| `/usr/local/bin/aphelion-secrets` | The [secrets broker](secrets.md#local-secrets-broker), compiled the same way |
| `/usr/local/lib/aphelion/plugin-runner.js` | The [plugin runner](plugins.md#running-the-runner), bundled into one file that `bun` runs |
| `/usr/local/bin/bun` | Bun 1.4.5, which runs the plugin runner and every plugin |
| `/usr/local/lib/aphelion/launch` | The launcher script that starts the processes |
| `/usr/bin/tini` | The init process, process 1 in the container |
| `/etc/aphelion/*.yaml` | The default config files, copied from [`docs/reference/config/example`](https://github.com/jcore9/Aphelion/tree/dev/docs/reference/config/example) |

The image also has `git` and `ca-certificates`. It has no AI tool such as Claude Code, Codex, Grok Build or OpenCode ([decision 0049](../decisions/0049-ai-tools-installed-from-a-list.md)). Issue [#155](https://github.com/jcore9/Aphelion/issues/155) adds a list to install them from.

## Users

| User | UID and GID | Runs | Extra groups |
| --- | --- | --- | --- |
| `harness` | 10001 | The server | `aphelion-bot`, to read the bot folders |
| `aphelion-bot` | 10002 | Bots, from M1 | None |
| `aphelion-secrets` | 10003 | The secrets broker | None |
| `aphelion-plugins` | 10004 | The plugin runner and every plugin | None |

The `harness` group has no members besides `harness`. The secrets broker's socket depends on that.

The image has no `sudo`. The build removes the Ubuntu image's default `ubuntu` user. It also clears the set-user-ID and set-group-ID bits on every file. Those bits let a program run as its file's owner, such as `root`.

## Folders

| Path | Owner and group | Mode | Kind | Holds |
| --- | --- | --- | --- | --- |
| `/etc/aphelion` | `harness:harness` | `0750` | Volume `config` | The [config files](config.md) |
| `/var/lib/aphelion` | `harness:harness` | `0700` | Volume `state` | The SQLite database |
| `/var/lib/aphelion-bots` | `aphelion-bot:aphelion-bot` | `0750` | Volume `bots` | One folder per bot |
| `/var/lib/aphelion-secrets` | `aphelion-secrets:aphelion-secrets` | `0700` | Volume `secrets` | The broker's encrypted store |
| `/var/lib/aphelion-plugins` | `aphelion-plugins:aphelion-plugins` | `0700` | Volume `plugin-data` | One data folder per plugin |
| `/opt/aphelion/plugins` | Set on the host | Read-only | Host folder `deploy/plugins` | The installed plugins |
| `/run/aphelion-secrets` | `aphelion-secrets:harness` | `2710` | Memory | The broker's socket |
| `/run/secrets/bootstrap` | `root:root` | `0400` | File from the host's `/run/credentials/aphelion.service/` | The [bootstrap key](secrets.md#the-bootstrap-key). It is a file, not a folder. |
| `/run` | `root:root` | `0755` | Memory | Runtime files |
| `/tmp` | `root:root` | `1777` | Memory, 1 GiB | Temporary files |

The rest of the file system is read-only.

Docker fills a new, empty volume from the image, and copies the owner and mode of the folder too. The launcher refuses to start if a folder in the table has another owner, or a mode with permissions beyond the one shown. `/run/aphelion-secrets` must have mode `2710` exactly.

Plugins are read-only inside the container, so a plugin can't change its own code or another plugin's code. The [plugin runner](plugins.md#how-your-plugin-is-started) refuses a plugin folder that `aphelion-plugins` owns or can write.

## How the processes start

`tini` runs the launcher, `/usr/local/lib/aphelion/launch`, as root. The launcher takes these steps:

1. It checks the owner and mode of each folder in the table above.
2. It checks that `/run/secrets/bootstrap` exists, belongs to root, and can't be read by any group or other user. The file holds the [bootstrap key](secrets.md#the-bootstrap-key), which `aphelion.service` loads and Compose mounts. If the file is missing, the launcher stops the container and says to start Aphelion with `systemctl`.
3. It creates the two pipes between the server and the plugin runner. A pipe is a one-way channel between two processes. The launcher makes each one as a named pipe in a new folder under `/run` that only root can open. It opens both ends of both pipes, and then deletes the folder.
4. It starts three processes. Each one starts with `setpriv --init-groups --inh-caps=-all --reset-env`, which switches to the process's user and its groups, drops every capability and clears the environment.
5. It closes its own copies of the pipes.

| Process | User | Standard input | Command |
| --- | --- | --- | --- |
| Secrets broker | `aphelion-secrets` | `/run/secrets/bootstrap`. The broker reads the key and closes it. | `aphelion-secrets` |
| Plugin runner | `aphelion-plugins` | The requests pipe. Its standard output is the replies pipe. | `bun plugin-runner.js --bun /usr/local/bin/bun --data /var/lib/aphelion-plugins` |
| Server | `harness` | Nothing. It reads replies on descriptor 3 and writes requests on descriptor 4. | `aphelion --headless --plugin-runner-fds 3,4` |

The bot runner comes with M1-04 ([#22](https://github.com/jcore9/Aphelion/issues/22)). The launcher will start it the same way.

If the environment variable `APHELION_PLUGIN_DEV_FOLDER` is set and not empty, the launcher adds `--plugin-dev` with its value to the server's command. [`deploy/compose.plugin-dev.yaml`](https://github.com/jcore9/Aphelion/blob/dev/deploy/compose.plugin-dev.yaml) sets it. Without the variable, the server opens no dev socket. See [Dev mode](plugins.md#dev-mode).

After the launcher closes its copies, only the server and the plugin runner hold the pipes, and no file in the file system leads to them. The server then starts every plugin that `aphelion plugin install` approved, if its manifest is still the approved one ([`aphelion --headless`](cli.md#aphelion---headless)).

### Stopping

On `SIGTERM`, which `docker compose stop` sends, the launcher stops the processes in this order:

1. It sends `SIGTERM` to the server and waits up to 20 seconds. The server asks the runner to stop each plugin.
2. It waits up to 5 seconds for the runner. The runner exits by itself when the server closes the pipe, and kills any plugin that is left. If the runner is still running, the launcher sends it `SIGTERM` and waits 5 more seconds.
3. It sends `SIGTERM` to the broker and waits up to 5 seconds.

A process that doesn't stop in time gets `SIGKILL`. The launcher then exits with code 0. The Compose file gives the container 45 seconds before Docker kills it.

If the server, the runner or the broker exits while the container runs, the launcher logs which one, stops the other two the same way, and exits with code 1. The container stops, and [`aphelion.service`](../guides/install.md#what-the-service-does) starts it again 10 seconds later.

## Hardening

| Setting | Value | Why |
| --- | --- | --- |
| `read_only` | `true` | No process can change the programs or the default settings. |
| `cap_drop` | `ALL` | Root in the container starts with no capabilities. |
| `cap_add` | `SETUID`, `SETGID` | The launcher needs them to switch each process to its user and groups. |
| `cap_add` | `KILL` | The launcher needs it to send `SIGTERM` to processes of other users at stop. Without it, a stop waits for Docker's timeout. |
| `security_opt` | `no-new-privileges:true` | No process can gain privileges, for example from a set-user-ID file. |
| seccomp | Docker's default profile | No custom profile ships ([decision 0045](../decisions/0045-no-bot-namespaces-default-seccomp.md)). |
| `pids_limit` | `1024` | Limits the number of processes. |
| `mem_limit`, `cpus` | `4g` and `2` | Set `APHELION_MEMORY` and `APHELION_CPUS` in `deploy/.env` to change them. |

The container is never privileged, and it never gets the Docker socket.

Root in the container holds only `SETUID`, `SETGID` and `KILL`. So root can't read the other users' folders, and only `tini`, the launcher and an administrator's `docker compose exec` run as root. Run `aphelion` commands as `harness`:

```sh
sudo docker compose exec -T --user harness aphelion aphelion device list
```

`-T` gives the command plain pipes instead of a terminal, so a token printed by `device add` stays alone on standard output.

## Network

The container joins a bridge network named `aphelion`. Its host interface is `aphelion0`, its subnet is `172.30.73.0/24`, and it has no IPv6. Set `APHELION_SUBNET` in `deploy/.env` if that subnet is in use on your network.

The server listens on port 7400 on every address inside the container. The Compose file publishes the port only on the host's tailnet address, which `APHELION_TAILNET_ADDRESS` sets. [`aphelion config check --compose -`](cli.md#checking-the-compose-file) refuses any other address.

The host firewall keeps the container away from the LAN, and the LAN away from the container ([decision 0022](../decisions/0022-bot-network-boundary.md)). [`deploy/host/firewall`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/firewall) installs two chains in iptables' `mangle` table:

- `APHELION-FORWARD` is the first rule of the `FORWARD` chain. It drops traffic from `aphelion0` to `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (the tailnet), `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, multicast and `240.0.0.0/4`. It also drops every new connection into the container, except one to port 7400 that arrives on the tailnet interface, `tailscale0`.
- `APHELION-INPUT` is the first rule of the `INPUT` chain. It drops traffic from `aphelion0` to any of the host's own addresses.

The second rule matters because Linux accepts a packet for any of the host's addresses on any interface. Without it, a LAN device that sends a packet to the host's tailnet address reaches the published port.

Both chains let replies through, but only replies to connections that were opened toward the container. Everything else from the container, including the AI providers' APIs, is allowed. If `ip6tables` works on the host, the script also drops all IPv6 traffic to and from `aphelion0`.

Decision 0022 named Docker's `DOCKER-USER` chain as the place for these rules. They live in the `mangle` table instead, because Linux checks it before the `filter` table, where Docker, Tailscale and ufw put their rules. Tailscale puts its own chain at the top of `FORWARD` in the `filter` table, and that chain accepts traffic that leaves on `tailscale0`. Rules in `DOCKER-USER` would come after it, so the container could reach other tailnet devices. Rules in `mangle` can't be skipped by a rule in `filter`.

The script builds each new chain under a temporary name, puts it in front of the old one, and only then removes the old one. A running container is never left without rules, even when an earlier run stopped partway. Only one run of the script changes the rules at a time. Set `APHELION_TAILNET_INTERFACE` in `deploy/.env` if Tailscale's interface has another name.

The rules stay in place until something removes them. The preflight installs them again at every start. A tool that flushes the `mangle` table while the server runs, such as `ufw reload` with `MANAGE_BUILTINS=yes`, removes them until the next start ([Check the network boundary](../guides/install.md#check-the-network-boundary)).

Names still resolve. Docker's resolver in the container sends its queries from the host's network, outside these rules. Docker 29.10 reported this as `ExtServers: [host(...)]` in the container's `/etc/resolv.conf`.

## Tests

[`deploy/test/image-contract.sh`](https://github.com/jcore9/Aphelion/blob/dev/deploy/test/image-contract.sh) builds the image and runs it with the real Compose file. CI runs it in the `container` job. It checks these things:

- The users, the groups, the missing `sudo` and AI tools, and the cleared set-user-ID bits.
- `config check` accepts the Compose file and refuses a port published on every address.
- A probe plugin, installed with `aphelion plugin install`, starts at boot as `aphelion-plugins`. It can't read the config, the state, the secrets store or the bot folders. It can't reach the broker, read the runner's or the server's pipe, or signal the server.
- `docker inspect` shows the settings in [Hardening](#hardening).
- Each process runs as its user with no capabilities, with no-new-privileges and with a seccomp filter. Only the server and the runner hold the pipes. The broker no longer holds the bootstrap file.
- The `secrets` volume holds `recipient.pub` and no `identity.agekey`.
- Each user, probed with `docker compose exec`, can reach what it needs and nothing else. Only root reads the bootstrap file.
- A stop exits with code 0. A plugin install survives a restart. A killed broker stops the container with code 1. The launcher refuses a bootstrap file that others can read, and a missing bootstrap file.
- The bootstrap key, made with `aphelion-secrets --new-key`, appears in no container log.

With `APHELION_TEST_TAILNET_ADDRESS` and `APHELION_TEST_LAN_ADDRESS` set, it also checks that `/health` answers on the tailnet address and not on the LAN address or `127.0.0.1`.

[`deploy/test/host-contract.sh`](https://github.com/jcore9/Aphelion/blob/dev/deploy/test/host-contract.sh) runs in a throwaway privileged container, never on the host's own firewall. It builds a small network of namespaces with a bridge named `aphelion0`, an interface named `tailscale0`, and a published port forwarded the way Docker does it. It checks that the firewall drops the container's traffic to the LAN, the host, the tailnet and the bridge, and still allows the internet. It checks that a tailnet client reaches the published port and that a LAN client doesn't, through the tailnet address or directly. It runs these checks with a rule that accepts everything placed first in the `filter` table's `FORWARD` and `INPUT` chains, as Tailscale and ufw do. It also checks that:

- a second run changes nothing, and a run after an interrupted one ends with the same rules;
- `systemd-analyze` accepts `aphelion.service`;
- the unit, `host/install` and `compose.yaml` name the same bootstrap credential;
- a key sealed with `systemd-creds encrypt` under umask `077` has mode `0600` and decrypts under the name the unit loads;
- the preflight script refuses a tailnet address that is malformed, missing or on another interface.

A real host checks the rest during the M0 exit test: the install, a reboot, Tailscale, and the firewall with Docker's own chains. [Check the network boundary](../guides/install.md#check-the-network-boundary) runs the six connects from the [M0-03 review](../spikes/M0-03-headless-on-bun.md#review-findings).

## Code

| File | Holds |
| --- | --- |
| [`deploy/Dockerfile`](https://github.com/jcore9/Aphelion/blob/dev/deploy/Dockerfile) | The image |
| [`deploy/image/launch`](https://github.com/jcore9/Aphelion/blob/dev/deploy/image/launch) | The launcher |
| [`deploy/compose.yaml`](https://github.com/jcore9/Aphelion/blob/dev/deploy/compose.yaml) | The Compose file |
| [`deploy/host/`](https://github.com/jcore9/Aphelion/tree/dev/deploy/host) | `aphelion.service` and the host scripts |
| [`apps/server/src/plugins/runner-pipe.ts`](https://github.com/jcore9/Aphelion/blob/dev/apps/server/src/plugins/runner-pipe.ts) | The server's end of the runner pipes |
| [`deploy/test/`](https://github.com/jcore9/Aphelion/tree/dev/deploy/test) | The two contract tests and the probe plugin |
