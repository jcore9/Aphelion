# Install the headless server

This guide installs Aphelion's server on an Ubuntu host. The server runs in one Docker container ([the container](../reference/container.md)). A systemd service, `aphelion.service`, starts it at boot. Devices reach it only over your tailnet.

The install was tested in parts on Debian 13 with Docker 29.10 and Compose 5.8 on x86-64. The M0 exit test runs the whole guide on a fresh Ubuntu VM.

## What you need

- Ubuntu 26.04 LTS ([decision 0011](../decisions/0011-ubuntu-lts.md)).
- Docker Engine and the Compose plugin, installed from [Docker's Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/). Keep Docker's default iptables firewall. The host firewall was tested only with it.
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

   The secrets store is the encrypted folder where Aphelion keeps passwords and API keys. The secrets broker is the small program in the container that opens it. The bootstrap key unlocks it ([decision 0050](../decisions/0050-bootstrap-key-is-the-store-key.md)).

   The first time, the script creates the bootstrap key in `/etc/credstore.encrypted/aphelion-bootstrap`. `systemd-creds`, a tool that comes with systemd, keeps the key encrypted on disk and decrypts it only for `aphelion.service`. The script never replaces a key that exists. If the file exists but holds no key, the script stops and changes nothing.

5. Make a recovery copy of the bootstrap key, as [Keep a recovery copy of the bootstrap key](#keep-a-recovery-copy-of-the-bootstrap-key) describes. Do it before you store any secret. If the host's disk fails, this copy is the only way to read the store on a new host.

6. Start the service.

   ```sh
   sudo systemctl start aphelion
   ```

7. From another device on the tailnet, check that the server answers. Replace the address with the host's tailnet address.

   ```sh
   curl http://100.71.226.67:7400/health
   ```

   You should see `{"status":"ok"}`.

8. Add a device token for your first client. The command prints the token once.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion device add laptop
   ```

Run every `docker compose` command in this guide from `/opt/aphelion/deploy`, so Compose finds the Compose file and `.env`.

## Keep a recovery copy of the bootstrap key

The bootstrap key is the only key to the secrets store. If the host's disk is lost, the key is lost with it, and so is every secret in the store. On a host with a TPM, a security chip on the motherboard, the key may also be tied to that chip, so a new machine can't decrypt the old file.

1. Print the key. The command shows the key on screen, so make sure that nobody can see your screen.

   ```sh
   sudo systemd-creds decrypt --name=bootstrap /etc/credstore.encrypted/aphelion-bootstrap -
   ```

   You should see one line that starts with `AGE-SECRET-KEY-1`.

2. Store the line in your password manager, apart from any backup of the server.
3. Clear the terminal with `clear`.

## Restore on new hardware

Put the bootstrap key on the new host before you run `host/install`, so that the script keeps it.

1. Create the folder for the key.

   ```sh
   sudo install -d -m 0700 /etc/credstore.encrypted
   ```

2. Start `systemd-creds`, which reads the key from your keyboard.

   ```sh
   sudo sh -c 'umask 077 && systemd-creds encrypt --name=bootstrap - /etc/credstore.encrypted/aphelion-bootstrap'
   ```

3. Paste the key from your password manager, press Enter, and then press Ctrl-D. The key never enters your shell history, because you paste it into `systemd-creds` and not into a command.
4. Check the result. You should see `AGE-SECRET-KEY-1`, the first 16 characters of the key. If you see anything else, repeat steps 2 and 3.

   ```sh
   sudo systemd-creds decrypt --name=bootstrap /etc/credstore.encrypted/aphelion-bootstrap - | cut -c1-16
   ```

5. Follow [Install](#install) from step 1.

The key alone restores nothing. The secrets themselves are in the `secrets` volume, and this guide has no tested way yet to back up a volume and restore it on another host. The broker refuses to start if the key doesn't match a store it finds, and the log then shows `The bootstrap key does not match this secrets store`.

## Start a fresh store after an older install

Before [#105](https://github.com/jcore9/Aphelion/issues/105), the store kept its key in plain text in a file called `identity.agekey`, inside the `secrets` volume. The broker now refuses to start while that file exists. It logs `The secrets store holds a plain-text key from before the host credential`.

No install from before #105 holds real secrets, so there is no tool to move that key. Delete the old store and let the broker start an empty one. This deletes every secret in it. Run these commands from `/opt/aphelion/deploy`. `docker compose down` removes the stopped container, which still holds the volume, and keeps the volumes.

```sh
sudo systemctl stop aphelion
sudo docker compose down
sudo docker volume rm aphelion_secrets
sudo systemctl start aphelion
```

## What the service does

[`aphelion.service`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/aphelion.service) starts at boot after Docker and Tailscale. It also starts whenever Docker starts, and stops when Docker stops. It decrypts the bootstrap key into `/run/credentials/aphelion.service/bootstrap`, a folder in memory that only root can read, and Compose gives that file to the container. Before each start, [`host/preflight`](https://github.com/jcore9/Aphelion/blob/dev/deploy/host/preflight) does three things:

1. It waits up to 120 seconds for `APHELION_TAILNET_ADDRESS` to appear on the tailnet interface, `tailscale0`. Docker can't publish a port on an address that doesn't exist yet.
2. It installs the [host firewall](../reference/container.md#network) again. Firewall rules don't survive a reboot, so every start installs them.
3. It runs `aphelion config check` on the rendered Compose file, as `harness`. The check refuses a port published anywhere but the tailnet.

If any step fails, the service doesn't start. Then the service runs `docker compose up` in the foreground. If the container stops with an error, systemd starts it again after 10 seconds.

Always start the server with `systemctl`. A plain `docker compose up` skips the firewall step and has no bootstrap key, so the container stops.

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

Other tools that change iptables' `mangle` table can remove the rules while the server runs. Two common ones are `sudo ufw reload` when `MANAGE_BUILTINS=yes` is set in `/etc/default/ufw`, and reloading `/etc/nftables.conf`, which starts with `flush ruleset`. After either one, restart the service so the preflight installs the rules again, and run the check again:

```sh
sudo systemctl restart aphelion
```

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
sudo host/install
sudo systemctl restart aphelion
```

`host/install` installs the new unit file and keeps the existing bootstrap key. If the service then stops and the log shows `The secrets store holds a plain-text key from before the host credential`, see [Start a fresh store after an older install](#start-a-fresh-store-after-an-older-install). The volumes keep the config, the database, the bot folders, the secrets store and the plugin data.

## Not covered yet

- AI tools such as Claude Code come from a list in [#155](https://github.com/jcore9/Aphelion/issues/155).
