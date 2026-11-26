# Install the headless server

This guide installs Aphelion's server on an Ubuntu host. The server runs in one Docker container ([the container](../reference/container.md)). A systemd service, `aphelion.service`, starts it at boot. Devices reach it only over your tailnet.

The install was tested in parts on Debian 13 with Docker 29.10 and Compose 5.8 on x86-64. The M0 exit test ran on 2026-11-24. It ran the install on Ubuntu 26.04.1 on a Proxmox VM. It then restored the backup on an existing Ubuntu 24.04.5 machine ([results](../plan/milestones/M0-exit-test.md)).

## What you need

- Ubuntu 26.04 LTS ([decision 0011](../decisions/0011-ubuntu-lts.md)).
- Docker Engine and the Compose plugin, installed from [Docker's Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/). Keep Docker's default iptables firewall. The host firewall was tested only with it.
- A 64-bit x86 processor with SSE4.2, a set of processor instructions that Bun, the program that runs the server, needs. Check with `grep -c sse4_2 /proc/cpuinfo`. It must print a number above 0. A virtual machine can hide the instructions from Ubuntu. In Proxmox, set the VM's CPU type to `host` (VM, Hardware, Processors, Edit, Type), then stop the VM fully and start it again. A reboot from inside the VM doesn't apply the change. Proxmox's `x86-64-v2-AES` type wasn't tested, so run the same check if you use it. arm64 hosts come in M1 ([#180](https://github.com/jcore9/Aphelion/issues/180)).
- Tailscale, signed in. `tailscale ip -4` prints the host's tailnet address.
- `git`, and an account with `sudo`.

Don't add anyone to the `docker` group. Membership in that group is the same as root on the host ([decision 0016](../decisions/0016-one-docker-container.md)). Run Docker with `sudo`.

## Install

1. Clone the latest release to `/opt/aphelion` as root. A release is a tag, which is a name fixed to one commit. You install a version that was tested, not whatever is on `main` today. The service runs the files in that folder, so only root may change them. Find the latest tag on [the releases page](https://github.com/jcore9/Aphelion/releases), and put it in `tag`:

   ```sh
   tag=v0.1.0-alpha.1
   sudo git clone --branch "$tag" https://github.com/jcore9/Aphelion.git /opt/aphelion
   ```

   Git says it is in a "detached HEAD" state. That is normal for a tag.

2. Write the host's tailnet address to `/opt/aphelion/deploy/.env`.

   ```sh
   echo "APHELION_TAILNET_ADDRESS=$(tailscale ip -4)" | sudo tee /opt/aphelion/deploy/.env
   ```

   The same file takes four optional settings. `APHELION_MEMORY` defaults to `4g`. `APHELION_CPUS` defaults to `2`. `APHELION_SUBNET` defaults to `172.30.73.0/24`. `APHELION_TAILNET_INTERFACE` defaults to `tailscale0`.

3. Build the image.

   ```sh
   cd /opt/aphelion/deploy
   sudo docker compose build
   ```

4. Install and enable the service.

   ```sh
   sudo host/install
   ```

   The script also links `/usr/local/bin/aphelion` to the `aphelion` command for the host, so `sudo aphelion` works from any folder. [The host command](../reference/host-command.md) describes it. Running the script again keeps the link as it is.

   The secrets store is the encrypted folder where Aphelion keeps passwords and API keys. The secrets broker is the small program in the container that opens the store. The bootstrap key unlocks the store ([decision 0050](../decisions/0050-bootstrap-key-is-the-store-key.md)).

   The first time, the script creates the bootstrap key in `/etc/credstore.encrypted/aphelion-bootstrap`. `systemd-creds`, a tool that comes with systemd, keeps the key encrypted on disk and decrypts it only for `aphelion.service`. The script never replaces a key that exists. If the file exists but doesn't hold a whole key, the script stops and leaves the file and the service as they are.

   When it creates the key, the script may print `Credential secret file '/var/lib/systemd/credential.secret' is not located on encrypted media, using anyway.` `systemd-creds` prints this when its host key sits on a disk that isn't encrypted. The host key is the key that `systemd-creds` encrypts the bootstrap key with. A TPM is a security chip on the motherboard. On a host without a TPM, the host key is the only protection. Anyone who copies the whole disk can then decrypt the bootstrap key. [Decision 0050](../decisions/0050-bootstrap-key-is-the-store-key.md#what-it-protects) accepts this. Encrypting the host's disk closes the gap.

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
   sudo aphelion device add laptop
   ```

9. Check the host. `check` prints `ok` or `FAIL` for each check the host can run alone, and how many passed. You should see no `FAIL`. `sudo aphelion status` shows whether the service, the container and each installed AI tool are up.

   ```sh
   sudo aphelion check
   ```

Run every `docker compose` command in this guide from `/opt/aphelion/deploy`, so Compose finds the Compose file and `.env`. The `aphelion` command works from any folder.

### What it runs underneath

`sudo aphelion device …` runs the server's own `aphelion` command inside the container, as the `harness` user, and passes its output and exit code through:

```sh
cd /opt/aphelion/deploy
sudo docker compose exec -T --user harness aphelion aphelion device add laptop
```

`status` and `check` ask `systemctl`, `docker compose ps`, `docker inspect`, `curl` and `iptables` read-only questions. [The host command](../reference/host-command.md) lists each one.

## Keep a recovery copy of the bootstrap key

The bootstrap key is the only key to the secrets store. If the host's disk is lost, the key is lost with it, and so is every secret in the store. A TPM is a security chip on the motherboard. On a host with a TPM, the key may also be tied to that chip. A new machine can't decrypt the old file then.

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

3. Paste the key from your password manager, press Enter, and then press Ctrl-D. The key never enters your shell history, because you paste it into `systemd-creds` and not into a command. It does show on screen while you paste, so make sure that nobody can see your screen, and clear the terminal with `clear` afterwards.
4. Check that the whole key arrived. The command counts the lines that look like a whole key, without showing the key. You should see `1`. If you see `0`, repeat steps 2 and 3.

   ```sh
   sudo systemd-creds decrypt --name=bootstrap /etc/credstore.encrypted/aphelion-bootstrap - | grep -cEx 'AGE-SECRET-KEY-1[0-9A-Z]{58}'
   ```

5. Follow [Install](#install) steps 1 to 4. Stop there and don't start the service. If you start it now, the secrets broker creates an empty store. Don't reboot either, because `host/install` enables the service, so it starts at boot. Then follow [Back up and restore](#back-up-and-restore) to put your data back.

The key alone restores nothing. The secrets themselves are in the `secrets` volume. [Back up and restore](#back-up-and-restore) moves that volume and the other five to a new host. The commands were run with Docker on a development machine and test data. The M0 exit test restored test data from an Ubuntu 26.04 VM on an existing Ubuntu 24.04 machine. That machine also held the backup, so the archive was copied locally instead of fetched over `ssh`. All three checks passed. The guide has not yet been tested on a host that holds real secrets.

The broker refuses to start if the key doesn't match a store it finds. The log then shows `The bootstrap key does not match this secrets store`.

## Back up and restore

A backup is one archive file that holds the contents of Aphelion's six Docker volumes. It doesn't hold the bootstrap key, or the host setup that [Install](#install) makes again, such as `deploy/.env` and the service. You restore it on a new host before the first start. To try the whole drill with test data first, see [Rehearse with test data](#rehearse-with-test-data).

A **volume** is a folder that Docker keeps for the container. Aphelion has six. A real install names them `aphelion_config`, `aphelion_state` and so on. Compose is the tool that reads `deploy/compose.yaml`. It names the project `aphelion` and puts the project name in front of each volume.

| Volume | Holds |
| --- | --- |
| `config` | The config files |
| `state` | The database: devices, plugin approvals and the audit log |
| `bots` | The bot folders |
| `secrets` | The encrypted secrets store |
| `plugin-data` | Data that plugins store |
| `plugin-files` | The plugins' files |

You keep two things, in two places:

- The recovery copy of the bootstrap key, in your password manager. [Keep a recovery copy of the bootstrap key](#keep-a-recovery-copy-of-the-bootstrap-key) makes it.
- The archive of the six volumes.

The archive holds the database and the bot folders as plain files. Only the `secrets` volume inside it is encrypted, by the bootstrap key. Store the archive on encrypted storage, and keep it apart from the key's copy. Someone who has both reads every secret.

The commands use `tar`, a program that packs a folder into one file. `--numeric-owner` and `--preserve-permissions` keep the user numbers and access modes that Aphelion's checks need. Each command runs in a short-lived container made from the `aphelion:local` image, so nothing is downloaded. Run every command from `/opt/aphelion/deploy`.

### Back up

1. Stop the service. A running server writes to the database, and a copy taken meanwhile can be broken.

   ```sh
   sudo systemctl stop aphelion
   ```

2. Make a private folder for the archive.

   ```sh
   sudo install -d -m 0700 /var/backups/aphelion
   ```

3. Write the archive. You should see no output.

   ```sh
   sudo docker run --rm --pull never --network none --entrypoint "" \
     -v aphelion_config:/data/config:ro \
     -v aphelion_state:/data/state:ro \
     -v aphelion_bots:/data/bots:ro \
     -v aphelion_secrets:/data/secrets:ro \
     -v aphelion_plugin-data:/data/plugin-data:ro \
     -v aphelion_plugin-files:/data/plugin-files:ro \
     -v /var/backups/aphelion:/backup \
     aphelion:local \
     tar --create --gzip --numeric-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data .
   ```

4. Write a checksum, a short fingerprint that shows later whether the file changed or broke in a copy.

   ```sh
   sudo sh -c 'cd /var/backups/aphelion && sha256sum aphelion-data.tar.gz > aphelion-data.tar.gz.sha256'
   ```

5. Start the service again.

   ```sh
   sudo systemctl start aphelion
   ```

6. Copy the archive and its checksum file off the host, for example to a machine you can reach with `ssh`. The command makes a new folder named after the date and time, which only you can read, and prints its name. A failed copy never replaces an older backup, because each copy gets its own folder.

   ```sh
   d=aphelion-backup-$(date +%Y%m%d-%H%M%S) && sudo tar --create --directory /var/backups/aphelion --file - aphelion-data.tar.gz aphelion-data.tar.gz.sha256 | ssh you@backup-machine "umask 077 && mkdir $d && tar --extract --directory $d --file -" && echo "$d"
   ```

7. Check the copy on the backup machine. Put the folder name that step 6 printed in place of `aphelion-backup-20261123-120000`. You should see `aphelion-data.tar.gz: OK`. Only `OK` means the backup is ready. If you see anything else, the copy or the `ssh` connection failed. Run step 6 again.

   ```sh
   ssh you@backup-machine 'cd aphelion-backup-20261123-120000 && sha256sum --check aphelion-data.tar.gz.sha256'
   ```

### Restore on the new host

Start from a host that has the bootstrap key in `/etc/credstore.encrypted/aphelion-bootstrap` ([Restore on new hardware](#restore-on-new-hardware)) and has finished [Install](#install) steps 1 to 4. The service must not have started. The first start creates empty volumes, and the secrets broker writes a new store in them.

1. Check that no Aphelion volume exists. The command should print nothing.

   ```sh
   sudo docker volume ls --quiet --filter name=aphelion_
   ```

   If it prints names, an earlier start made them. Restoring over them would mix old and new files. Continue only if they hold nothing you need. Stop the service and remove the stopped container, which still holds the volumes. `down` without `-v` keeps the volumes, so you remove them one by one after.

   ```sh
   sudo systemctl stop aphelion
   ```

   ```sh
   sudo docker compose down
   ```

   Then remove each volume with `sudo docker volume rm <name>`.

2. Put the archive and its checksum file in a private folder on the new host.

   ```sh
   sudo install -d -m 0700 /var/backups/aphelion
   ```

   For example, run this on the new host to fetch them from the backup machine. Put the name of the backup folder in place of `aphelion-backup-20261123-120000`.

   ```sh
   ssh you@backup-machine 'tar --create --directory aphelion-backup-20261123-120000 --file - aphelion-data.tar.gz aphelion-data.tar.gz.sha256' | sudo tar --extract --no-same-owner --directory /var/backups/aphelion --file -
   ```

3. Check the archive. You should see `aphelion-data.tar.gz: OK`.

   ```sh
   sudo sh -c 'cd /var/backups/aphelion && sha256sum --check aphelion-data.tar.gz.sha256'
   ```

4. Create the six volumes with the labels that Compose puts on its own. Without the labels, Compose warns that it didn't create them, and `docker compose down -v` skips them. You should see the six volume names.

   ```sh
   for v in config state bots secrets plugin-data plugin-files; do
     sudo docker volume create --label com.docker.compose.project=aphelion --label com.docker.compose.volume=$v aphelion_$v
   done
   ```

5. Unpack the archive into the volumes. You should see no output.

   ```sh
   sudo docker run --rm --pull never --network none --entrypoint "" \
     -v aphelion_config:/data/config \
     -v aphelion_state:/data/state \
     -v aphelion_bots:/data/bots \
     -v aphelion_secrets:/data/secrets \
     -v aphelion_plugin-data:/data/plugin-data \
     -v aphelion_plugin-files:/data/plugin-files \
     -v /var/backups/aphelion:/backup:ro \
     aphelion:local \
     tar --extract --gzip --numeric-owner --same-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data
   ```

6. Finish the restore. This revokes every device token in the restored database and switches every plugin off, so the server starts with nobody enrolled and no plugin running. A backup can be old, and a device you removed since then comes back with it. The command runs in a throwaway container, like step 5, and doesn't need the bootstrap key.

   ```sh
   sudo docker run --rm --pull never --network none --entrypoint "" --user harness \
     -v aphelion_state:/var/lib/aphelion \
     aphelion:local \
     aphelion restore finish
   ```

   It prints one line for each plugin, with the command that switches it on, and then the command that enrolls a device. For the test data you should see:

   ```text
   Restore finished. Every device token is revoked.
   Plugin aphelion-test-plugin is switched off. Switch it on: aphelion plugin enable aphelion-test-plugin
   Enroll a device: aphelion device add NAME
   ```

   Running it again prints the same lines and revokes every device again, including any you enrolled in between. Enroll that device again afterwards.

   Don't start the service until this step prints `Restore finished`. If it fails, the restored tokens and plugins are still live, so fix the cause and run it again first.

7. Start the service.

   ```sh
   sudo systemctl start aphelion
   ```

Then enroll a device and switch each plugin back on with the commands from step 6 ([Check the restore](#check-the-restore) shows them).

If the key doesn't match the restored `secrets` volume, the container exits and systemd tries again every 10 seconds. `sudo journalctl -u aphelion` shows `The bootstrap key does not match this secrets store`. The key and the archive came from different installs. Stop the service with `sudo systemctl stop aphelion`, put the right key in place with [Restore on new hardware](#restore-on-new-hardware) steps 2 to 4, and start it again. The volumes stay as they are.

A plugin can come back in two ways. Restoring `plugin-files` brings its files back as they were. You can also install it again and skip `plugin-files`. Either way, the plugin starts switched off, because `restore finish` switches it off in step 6. Its approval stays in the database and records the plugin's folder, and a digest of its files. `aphelion plugin enable` shows the permissions it already has and, when you approve, switches it on. The digest is a fingerprint made from each file's path inside the plugin folder and its contents, and [the plugin reference](../reference/plugins.md#permissions) describes it. A plugin that you install again must go in the same folder, with the same files, byte for byte. A file that differs in one byte stops `plugin enable`, and you approve the plugin again with [Install a plugin](#install-a-plugin). The `plugin-data` volume holds data that a plugin stores, and a new install doesn't recreate it, so restore that volume either way.

### Check the restore

Run three checks from `/opt/aphelion/deploy` once the service has started. They use the test data from [Rehearse with test data](#rehearse-with-test-data). After a real restore, check a plugin and a device that you know, and check a real secret by using the feature that needs it. Never type a real secret's value into a command.

1. A secret reads back. No `aphelion` command reads a secret, so this asks the secrets broker through Bun, the program inside the image that runs the server. It prints the broker's status code, and then `true` if the value matches. You should see `200 true`.

   ```sh
   sudo docker compose exec -T --user harness aphelion bun -e 'const r = await fetch("http://broker/v1/local", {unix: "/run/aphelion-secrets/broker.sock", method: "POST", body: JSON.stringify({op: "read", ref: "local://drill/test"})}); console.log(r.status, r.ok && (await r.json()) === "drill-value-not-a-real-secret")'
   ```

2. A plugin comes back switched off, and you switch it on. First check that it didn't start. You should see `plugin host started` with `"installed":1`, the line `a switched-off plugin was not started`, and no `aphelion-test-plugin 1.0.0 started`.

   ```sh
   sudo docker compose logs --no-color | grep -E 'plugin host started|switched-off|aphelion-test-plugin'
   ```

   Preview the plugin, then repeat the command with the `--approve` value it printed. You should see `Switched on aphelion-test-plugin. It runs.`

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin enable aphelion-test-plugin
   ```

3. The device history is there, and every token is revoked. You should see the device `drill-laptop` with the same ID that `device add` printed on the old host, and the status `revoked`. Then enroll a device. Its token works, and the old one gets a 401.

   ```sh
   sudo aphelion device list
   ```

   ```sh
   sudo aphelion device add drill-laptop
   ```

If a check doesn't show what it should, write down the command and its output.

### Rehearse with test data

Use this on the old host, before [Back up](#back-up). It makes one secret, one approved plugin and one device. The values are made up.

1. Write the test secret. You should see `204`.

   ```sh
   sudo docker compose exec -T --user harness aphelion bun -e 'const r = await fetch("http://broker/v1/local", {unix: "/run/aphelion-secrets/broker.sock", method: "POST", body: JSON.stringify({op: "write", ref: "local://drill/test", value: "drill-value-not-a-real-secret"})}); console.log(r.status)'
   ```

2. Add the test device. The command discards its token. You should see its ID and expiry on the screen.

   ```sh
   sudo aphelion device add drill-laptop > /dev/null
   ```

3. Unpack the test plugin from the repository into a folder, and make its files readable by everyone and writable only by you.

   ```sh
   mkdir ~/aphelion-test-plugin && tar -xf /opt/aphelion/apps/server/src/plugins/updates/fixtures/aphelion-test-plugin/v1.0.0/aphelion-plugin.tar -C ~/aphelion-test-plugin && chmod -R a+rX,go-w ~/aphelion-test-plugin
   ```

4. Copy the folder into the `plugin-files` volume, and preview its permissions.

   ```sh
   sudo docker compose cp ~/aphelion-test-plugin aphelion:/opt/aphelion/plugins/aphelion-test-plugin
   ```

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/plugins/aphelion-test-plugin
   ```

5. Repeat the second command with the `--approve` value it printed. You should see `Plugin approved.`

6. Restart the service, so the server starts the plugin.

   ```sh
   sudo systemctl restart aphelion
   ```

7. Check that the device is listed, then follow [Back up](#back-up).

   ```sh
   sudo aphelion device list
   ```

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

[`aphelion.service`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/aphelion.service) starts at boot after Docker and Tailscale. It also starts whenever Docker starts, and stops when Docker stops. It decrypts the bootstrap key into `/run/credentials/aphelion.service/bootstrap`, a folder in memory that only root can read, and Compose gives that file to the container. Before each start, [`host/preflight`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/preflight) does three things, in this order:

1. It waits up to 120 seconds for `APHELION_TAILNET_ADDRESS` to appear on the tailnet interface, `tailscale0`. Docker can't publish a port on an address that doesn't exist yet.
2. It installs the [host firewall](../reference/container.md#network) again. Firewall rules don't survive a reboot, so every start installs them.
3. It runs `aphelion config check` on the rendered Compose file, as `harness`. The check refuses a port published anywhere but the tailnet. It also refuses a `server.yaml` that the published port can't reach. The server must listen on address `0.0.0.0` and port 7400 ([decision 0055](../decisions/0055-compose-check-server-listener.md)).

If any step fails, the service doesn't start. If all three succeed, the service runs `docker compose up` in the foreground. If the container stops with an error, systemd starts it again after 10 seconds.

Always start the server with `systemctl`. A plain `docker compose up` skips the firewall step and has no bootstrap key, so the container stops.

## Install a plugin

Plugins live in the `plugin-files` volume. A volume is a folder that Docker keeps for the container, and it survives an image rebuild. The container sees this one at `/opt/aphelion/plugins`. Plugins can read it, but can't change it. Run these steps in `/opt/aphelion/deploy` while the service runs.

1. Unpack the plugin into a folder named after it, then make every file readable by everyone and writable only by you.

   ```sh
   chmod -R a+rX,go-w <name>
   ```

2. Copy the folder into the volume. Docker gives the copy to `root`, so the plugin can't change its own files.

   ```sh
   sudo docker compose cp <name> aphelion:/opt/aphelion/plugins/<name>
   ```

3. Preview its permissions.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/plugins/<name>
   ```

4. If you accept the permissions, repeat the command with the `--approve` value it printed. The approval covers every file in the folder, so approve again after any file changes.
5. Restart the service. The server starts every approved plugin when it starts.

   ```sh
   sudo systemctl restart aphelion
   ```

[Running plugins on the server](../reference/plugins.md#permissions) explains the approval. To write a plugin, see [Write your first server plugin](write-your-first-server-plugin.md).

## Update a plugin

A plugin whose manifest names a GitHub `repository` updates from that repository's releases. Aphelion checks that GitHub's release workflow built each release, and installs it only after you approve it. The server keeps running while the plugin switches version. Run these steps in `/opt/aphelion/deploy` while the service runs.

1. Check for a newer release and preview it. Use the plugin's `id`, such as `aphelion-test-plugin`.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin update <id>
   ```

   When the latest release is the installed version, the command prints `<id> is already on <version>, the latest release. If the server still runs an older version, run aphelion plugin restart <id>.` and you are done. The server can still run an older version if an earlier `--approve` run stopped after it installed the release and before it restarted the plugin. In that case, run `sudo docker compose exec -T --user harness aphelion aphelion plugin restart <id>`. If the latest release is not the installed version, the command prints the two versions, the permissions the new version adds or drops, and an `--approve` value.

2. If you accept the changes, repeat the command with the `--approve` value it printed.

   ```sh
   sudo docker compose exec -T --user harness aphelion aphelion plugin update <id> --approve <value>
   ```

   The command installs the release and restarts the plugin on it. It prints `Updated <id> from <old version> to <new version>.` and then `<id> <new version> runs.`

If the new version doesn't start, Aphelion goes back to the old version on its own, says so, and exits with code 1. The server log says why the new version stopped.

The command refuses a release that GitHub's attestation doesn't vouch for, with one sentence that says why. Nothing changes, and the running version keeps running. [Updates](../reference/plugins.md#updates) lists every check and limit.

## Go back a version

Aphelion keeps the version before the current one. To go back to it, run:

```sh
sudo docker compose exec -T --user harness aphelion aphelion plugin rollback <id>
```

The command prints `Went back from <id> <current version> to <earlier version>.` and then `<id> <earlier version> runs.` It deletes the version it left, so you can go back only once. To return to the newer version, [update the plugin](#update-a-plugin) again.

## Check the network boundary

The container must not reach your LAN, the host or other tailnet devices ([decision 0022](../decisions/0022-bot-network-boundary.md)). [`host/network-check`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/network-check) connects to six targets as `aphelion-bot` inside the running container. Give it these targets, in this order:

1. Your LAN gateway, such as your router.
2. The host's LAN address.
3. The host's tailnet address.
4. Another device on your tailnet.
5. The bridge gateway, which is `172.30.73.1` by default.
6. A host on the internet.

Each target is an address and an open port. For example:

```sh
sudo host/network-check 10.0.0.1:80 10.0.0.133:22 100.71.226.67:22 100.93.139.95:22 172.30.73.1:22 1.1.1.1:443
```

The script first connects to each target from the host itself. It stops if a target doesn't answer, so pick targets with an open port. The first five must then print `blocked`. That means the connection from the container timed out, because the firewall dropped it. A target that refuses the connection also fails the check, because the refusal came back from that target. The sixth must print `reachable`, and names must resolve. The script exits with code 1 if any check fails, and with code 2 if a target is malformed or the container isn't running.

Aphelion refuses to start when ufw is enabled and `MANAGE_BUILTINS=yes` is set in `/etc/default/ufw`. To fix this, set `MANAGE_BUILTINS=no` in that file, then run these commands.

```sh
sudo ufw reload
sudo systemctl restart docker
```

Docker rebuilds its chains, and `aphelion.service` restarts with it and installs Aphelion's rules. Once Aphelion runs again, run the network check above.

Preflight runs only when Aphelion starts. If you set `yes` later, while Aphelion runs, the next `sudo ufw reload` or `sudo ufw enable` removes Aphelion's rules and Docker's chains. They stay gone until you fix the setting and restart Docker as above. Restarting Aphelion alone doesn't bring them back. Make sure `MANAGE_BUILTINS=no` is set before you run either command. Preflight reads `/etc/default/ufw` the way ufw does, so if it sets `MANAGE_BUILTINS` more than once, the last line counts.

The M0 exit test tried two `ufw` settings on Ubuntu 26.04 with Docker 29.10, with ufw turned on:

- With ufw's default setting, `MANAGE_BUILTINS=no` in `/etc/default/ufw`, `sudo ufw reload` left Aphelion's rules in place, and the check still passed.
- With `MANAGE_BUILTINS=yes`, `sudo ufw reload` removed the rules that send traffic into Aphelion's chains, and deleted Docker's own `DOCKER` chain. The check then showed the container connecting to the host's LAN, tailnet and bridge addresses, and failing to reach `1.1.1.1:443`. Restarting `aphelion` didn't help. `sudo journalctl -u aphelion` showed this line every 10 seconds:

  ```text
  failed to set up container networking: ... iptables failed: iptables --wait -t filter -I DOCKER ... iptables: No chain/target/match by that name.
  ```

Reloading a file that contains `flush ruleset`, such as `/etc/nftables.conf`, can clear Docker's and Aphelion's rules too, when `iptables` uses the nftables backend. This wasn't tested. After such a reload, restart Docker the same way and run the check again.

## Logs

```sh
journalctl -u aphelion
sudo docker compose logs
```

The launcher, the server, the broker, the plugin runner and the plugins all log to the same stream.

## Upgrade

Find the latest tag on [the releases page](https://github.com/jcore9/Aphelion/releases), put it in `tag`, and check it out:

```sh
tag=v0.1.0-alpha.2
cd /opt/aphelion &&
	sudo git fetch --tags &&
	sudo git checkout --detach "refs/tags/$tag" &&
	cd deploy &&
	sudo docker compose build &&
	sudo host/install &&
	sudo systemctl restart aphelion
```

Each command runs only if the one before it worked, so a mistyped tag stops the upgrade before anything is rebuilt.

`host/install` installs the new unit file and keeps the existing bootstrap key.

If you upgrade from a version that kept plugins in `/opt/aphelion/deploy/plugins`, install each plugin again. That version mounted the host folder. This one keeps plugins in the `plugin-files` volume, and it checks every file of a plugin, so earlier approvals don't carry over. For each folder in `/opt/aphelion/deploy/plugins`, follow [Install a plugin](#install-a-plugin) from step 2. Until you do, the server doesn't start that plugin. Then you can delete `/opt/aphelion/deploy/plugins`. If the service then stops and the log shows `The secrets store holds a plain-text key from before the host credential`, see [Start a fresh store after an older install](#start-a-fresh-store-after-an-older-install). The volumes keep the config, the database, the bot folders, the secrets store and the plugin data.

## Not covered yet

- AI tools such as Claude Code come from a list in [#155](https://github.com/jcore9/Aphelion/issues/155).
