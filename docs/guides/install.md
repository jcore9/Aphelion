# Install the headless server

This guide installs Aphelion's server on an Ubuntu host. The server runs in one Docker container ([the container](../reference/container.md)). A systemd service, `aphelion.service`, starts it at boot. Devices reach it only over your tailnet.

The install was tested in parts on Debian 13 with Docker 29.10 and Compose 5.8 on x86-64. The M0 exit test runs the whole guide on a fresh Ubuntu VM.

## What you need

- Ubuntu 26.04 LTS ([decision 0011](../decisions/0011-ubuntu-lts.md)).
- Docker Engine and the Compose plugin, installed from [Docker's Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/). Keep Docker's default iptables firewall. The host firewall needs Docker's `DOCKER-USER` chain, and the nftables firewall in Docker doesn't have one.
- Tailscale, signed in. `tailscale ip -4` prints the host's tailnet address.
- `git`, and an account with `sudo`.

Don't add anyone to the `docker` group. Membership in that group is the same as root on the host ([decision 0016](../decisions/0016-one-docker-container.md)). Run Docker with `sudo`.

## Install

1. Clone the `dev` branch to `/opt/aphelion` as root. The service runs the files there, so only root may change them. Until the first release, only `dev` has the deployment files.

   ```sh
   sudo git clone --branch dev https://github.com/jcore9/Aphelion.git /opt/aphelion
   ```

2. Write the host's tailnet address to `/opt/aphelion/deploy/.env`.

   ```sh
   echo "APHELION_TAILNET_ADDRESS=$(tailscale ip -4)" | sudo tee /opt/aphelion/deploy/.env
   ```

   The same file takes four optional settings: `APHELION_MEMORY` (default `4g`), `APHELION_CPUS` (default `2`), `APHELION_SUBNET` (default `172.30.73.0/24`) and `APHELION_TAILNET_INTERFACE` (default `tailscale0`).

3. Build the image.

   ```sh
   cd /opt/aphelion/deploy
   sudo docker compose build
   ```

4. Install and enable the service.

   ```sh
   sudo host/install
   ```

5. Start the service.

   ```sh
   sudo systemctl start aphelion
   ```

6. From another device on the tailnet, check that the server answers. Replace the address with the host's tailnet address.

   ```sh
   curl http://100.71.226.67:7400/health
   ```

   You should see `{"status":"ok"}`.

7. Add a device token for your first client. The command prints the token once.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion device add laptop
   ```

Run every `docker compose` command in this guide from `/opt/aphelion/deploy`, so Compose finds the Compose file and `.env`.

## What the service does

[`aphelion.service`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/aphelion.service) starts at boot after Docker and Tailscale. It also starts whenever Docker starts, and stops when Docker stops. Before each start, [`host/preflight`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/preflight) does three things:

1. It waits up to 120 seconds for `APHELION_TAILNET_ADDRESS` to appear on the tailnet interface, `tailscale0`. Docker can't publish a port on an address that doesn't exist yet.
2. It installs the [host firewall](../reference/container.md#network) again. Firewall rules don't survive a reboot, so every start installs them.
3. It runs `aphelion config check` on the rendered Compose file, as `harness`. The check refuses a port published anywhere but the tailnet.

If any step fails, the service doesn't start. Then the service runs `docker compose up` in the foreground. If the container stops with an error, systemd starts it again after 10 seconds.

Always start the server with `systemctl`. A plain `docker compose up` skips the firewall step.

## Install a plugin

1. Unpack the plugin into `/opt/aphelion/deploy/plugins/<name>` as root, readable by everyone and writable only by root. The container sees it, read-only, at `/opt/aphelion/plugins/<name>`.
2. Preview its permissions.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/plugins/<name>
   ```

3. If you accept the permissions, repeat the command with the `--approve` value it printed.
4. Restart the service. The server starts every approved plugin when it starts.

   ```sh
   sudo systemctl restart aphelion
   ```

[Running plugins on the server](../reference/plugins.md#permissions) explains the approval.

## Check the network boundary

The container must not reach your LAN, the host or other tailnet devices ([decision 0022](../decisions/0022-bot-network-boundary.md)). [`host/network-check`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/network-check) connects to six targets as `aphelion-bot` inside the running container. Give it, in order:

1. your LAN gateway, such as your router;
2. the host's LAN address;
3. the host's tailnet address;
4. another device on your tailnet;
5. the bridge gateway, `172.30.73.1` by default;
6. a host on the internet.

Each target is an address and an open port. For example:

```sh
sudo host/network-check 10.0.0.1:80 10.0.0.133:22 100.71.226.67:22 100.93.139.95:22 172.30.73.1:22 1.1.1.1:443
```

The script first connects to each target from the host itself, and stops if one doesn't answer. Pick targets with an open port. The first five must then print `blocked`, which means the connection from the container timed out because the firewall dropped it. A target that refuses the connection also fails the check, because the refusal came back from that target. The sixth must print `reachable`, and names must resolve. The script exits with code 1 if any check fails, and with code 2 if a target is malformed or the container isn't running.

Other tools that change Docker's `DOCKER-USER` chain or the `INPUT` chain can break the boundary. Run the check again after you change the host's firewall.

## Logs

```sh
journalctl -u aphelion
sudo docker compose logs
```

The launcher, the server, the broker, the plugin runner and the plugins all log to the same stream.

## Upgrade

```sh
cd /opt/aphelion
sudo git pull --ff-only
cd deploy
sudo docker compose build
sudo systemctl restart aphelion
```

The volumes keep the config, the database, the bot folders, the secrets store and the plugin data.

## Not covered yet

- The bootstrap secret, stored with `systemd-creds` and loaded with `LoadCredentialEncrypted=`, comes with [#105](https://github.com/jcore9/Aphelion/issues/105).
- AI tools such as Claude Code come from a list in [#155](https://github.com/jcore9/Aphelion/issues/155).
