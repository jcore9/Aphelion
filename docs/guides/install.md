# Install the headless server

This guide installs Aphelion's server on an Ubuntu host. The server runs in one Docker container ([the container](../reference/container.md)). A systemd service, `aphelion.service`, starts it at boot. Devices reach it only over your tailnet.

The install was tested in parts on Debian 13 with Docker 29.10 and Compose 5.8 on x86-64. The M0 exit test ran on 2026-11-24. It ran the install on Ubuntu 26.04.1 on a Proxmox VM. It then restored the backup on an existing Ubuntu 24.04.5 machine ([results](../plan/milestones/M0-exit-test.md)).

## What you need

- Ubuntu 26.04 LTS ([decision 0011](../decisions/0011-ubuntu-lts.md)).
- Docker Engine and the Compose plugin, installed from [Docker's Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/). Keep Docker's default iptables firewall. The host firewall was tested only with it.
- For x86-64, a 64-bit x86 processor with SSE4.2, a set of processor instructions that Bun, the program that runs the server, needs. Check with `grep -c sse4_2 /proc/cpuinfo`. It must print a number above 0. A virtual machine can hide the instructions from Ubuntu. In Proxmox, set the VM's CPU type to `host` (VM, Hardware, Processors, Edit, Type), then stop the VM fully and start it again. A reboot from inside the VM doesn't apply the change. Proxmox's `x86-64-v2-AES` type wasn't tested, so run the same check if you use it.
- Or a 64-bit arm64 processor, also called aarch64. See [arm64](#arm64).
- Tailscale, signed in. `tailscale ip -4` prints the host's tailnet address.
- `git`, and an account with `sudo`.

Don't add anyone to the `docker` group. Membership in that group is the same as root on the host ([decision 0016](../decisions/0016-one-docker-container.md)). Run Docker with `sudo`.

## Install

### Install with one command

The installer does everything under [Install step by step](#install-step-by-step) except one thing: it asks you to save the recovery key. Run it on an Ubuntu host that has Tailscale signed in. Find the latest tag on [the releases page](https://github.com/jcore9/Aphelion/releases), and put it in `tag`. The first release that has the installer is `v0.1.0-alpha.2`:

```sh
tag=v0.1.0-alpha.2
script=$(mktemp) && curl -fsSLo "$script" "https://raw.githubusercontent.com/jcore9/Aphelion/$tag/deploy/install.sh" && sudo bash "$script" --tag "$tag"
```

The command saves the installer script of that release to a file, and runs it as root only if the download worked. A download that fails or stops halfway runs nothing. To read the script first, open [`deploy/install.sh`](https://github.com/jcore9/Aphelion/blob/main/deploy/install.sh). The script does these steps in order. Each step checks first and skips itself when it is already done.

1. It stops, before it changes anything, if the host isn't Ubuntu, if an x86-64 processor hides SSE4.2 ([What you need](#what-you-need) explains the setting), if Tailscale has no address for the host, or if ufw is enabled with `MANAGE_BUILTINS=yes`. It also looks at an existing `/opt/aphelion`, and stops if root doesn't own it, if others can write to it, if its origin isn't the Aphelion repository, or if it has local changes. It never writes firewall rules.
2. It installs Docker Engine and the Compose plugin from Docker's Ubuntu repository, if Compose isn't there.
3. It clones the tag to `/opt/aphelion`. If the clone is already there, it moves a clean clone to the tag.
4. It writes `/opt/aphelion/deploy/.env` with the host's tailnet address, unless the file exists. It never changes an existing file.
5. It gets the image. It tries to download the image that the release published, and refuses the download if the image's digest differs from the one in the release's `aphelion-image.sha256` file. If there is no such file, or the download fails, it builds the image on the host. The image package is private today, so expect the build. It takes a while. This step runs every time, so a run that finds a stale image replaces it. If the image fails the digest check after the installer moved an existing clone to another tag, the installer moves the clone back to the commit it was on.
6. It runs `host/install`, which creates the bootstrap key and installs the service.
7. It shows the bootstrap key on your screen, so you can save a recovery copy. You type `saved` to go on. The key goes to your terminal only, never to a file or a pipe.
8. It starts the service. The service runs `host/preflight` itself first, and the start fails if a check fails. The installer doesn't run the preflight, because the check needs the bootstrap key that only the running service has.

Run the same command again, and each step says it is already done and changes nothing. With a built image, the build step runs again, and Docker's cache makes it quick. The installer doesn't restart a running service. It refuses `--no-start` and a different tag while the service runs, and changes nothing. To move a running server to a newer release, see [Upgrade](#upgrade).

The installer reads your answers from the terminal, not from the pipe. With no terminal, it does steps 1 to 6, then stops before the key and the start. It says what to run to finish: print and save the key, then `sudo systemctl start aphelion`.

To install without starting the service, add `--no-start` after `--tag "$tag"`. Use it on a host where you restore a backup next ([Restore on new hardware](#restore-on-new-hardware)). With `--no-start`, the installer skips steps 7 and 8. It refuses `--no-start` while the service runs: stop the service first with `sudo systemctl stop aphelion`.

### Install step by step

Do these steps by hand if you want to see each one, or if the installer stopped and you want to continue from there.

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

   The first time, the script creates the bootstrap key in `/etc/credstore.encrypted/aphelion-bootstrap`. `systemd-creds`, a tool that comes with systemd, keeps the key encrypted on disk and decrypts it only for `aphelion.service`. The script never replaces a key that exists. If the file exists but doesn't hold a valid key, the script stops and leaves the file and the service as they are. The script asks the image's own `aphelion-secrets --check-key`, the same check the broker makes when it starts. A key with a typo is caught here and not at the first start.

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

   To try a bot, [chat with it from the command line](test-client.md).

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

`chat` starts a short-lived container from the service's image on the host's network, as the `harness` user, with no mounts and all capabilities dropped. It needs a terminal, and the token is typed at its prompt:

```sh
sudo docker run --rm -it --pull never --network host --entrypoint "" --user harness \
  --cap-drop ALL --security-opt no-new-privileges:true IMAGE \
  aphelion chat chief --url ws://ADDRESS:7400/ws
```

`IMAGE` is the first line of `docker compose config --images`, and `ADDRESS` is `APHELION_TAILNET_ADDRESS` in `.env`. [The test client guide](test-client.md) shows a session.

`sign-in`, `backup`, `restore`, `plugin`, `logs`, `upgrade` and `network-check` run the host and Docker commands for you too. [Back up](#back-up), [Restore on the new host](#restore-on-the-new-host), [Install a plugin](#install-a-plugin), [Install an AI tool](#install-an-ai-tool), [Check the network boundary](#check-the-network-boundary), [Logs](#logs) and [Upgrade](#upgrade) show the commands under each one.

`status` and `check` ask `systemctl`, `docker compose ps`, `docker inspect`, `curl`, `iptables` and `ip6tables` read-only questions. [The host command](../reference/host-command.md) lists each one.

## arm64

The image builds for x86-64 and arm64 from the same `deploy/Dockerfile`, and the install steps are the same on both. Docker picks the right build for the host.

The arm64 build is tested on one machine: GitHub's hosted arm64 runner (`ubuntu-24.04-arm`) in Aphelion's CI. There, the container checks in [`deploy/test/image-contract.sh`](https://github.com/jcore9/Aphelion/blob/main/deploy/test/image-contract.sh) pass, and a smoke test starts the image, checks `/health`, runs `aphelion tool install claude`, and runs `claude --version` as `aphelion-bot`. The smoke test is [`deploy/test/image-smoke.sh`](https://github.com/jcore9/Aphelion/blob/main/deploy/test/image-smoke.sh).

Not tested on arm64: signing in to an AI tool, and chatting with a bot. The host steps (the systemd service, the firewall, the installer) were tested only on x86-64.

`aphelion tool install` picks the arm64 download for each tool from the list. A tool whose list entry has no arm64 download shows `unavailable` in `aphelion tool list`, and `aphelion tool install` refuses it. All four tools on the shipped list have an arm64 entry.

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

5. Run the installer with `--no-start` ([Install with one command](#install-with-one-command)), or follow [Install step by step](#install-step-by-step) steps 1 to 4. Stop there and don't start the service. If you start it now, the secrets broker creates an empty store. Don't reboot either, because `host/install` enables the service, so it starts at boot. Then follow [Back up and restore](#back-up-and-restore) to put your data back.

The key alone restores nothing. The secrets themselves are in the `secrets` volume. [Back up and restore](#back-up-and-restore) moves that volume and the other five to a new host. The commands were run with Docker on a development machine and test data. The M0 exit test restored test data from an Ubuntu 26.04 VM on an existing Ubuntu 24.04 machine. That machine also held the backup, so the archive was copied locally instead of fetched over `ssh`. All three checks passed. The guide has not yet been tested on a host that holds real secrets.

The broker refuses to start if the key doesn't match a store it finds. The log then shows `The bootstrap key does not match this secrets store`.

## Back up and restore

A backup is one archive file that holds the contents of Aphelion's six Docker volumes. It doesn't hold the bootstrap key, or the host setup that [Install](#install) makes again, such as `deploy/.env` and the service. It does hold every bot's saved conversation, because the database does. Keep the archive as private as the server. You restore it on a new host before the first start. To try the whole drill with test data first, see [Rehearse with test data](#rehearse-with-test-data).

A **volume** is a folder that Docker keeps for the container. Aphelion has six. A real install names them `aphelion_config`, `aphelion_state` and so on. Compose is the tool that reads `deploy/compose.yaml`. It names the project `aphelion` and puts the project name in front of each volume.

| Volume | Holds |
| --- | --- |
| `config` | The config files |
| `state` | The database: devices, plugin approvals, the audit log and the bots' saved conversations |
| `bots` | The bot folders |
| `secrets` | The encrypted secrets store |
| `plugin-data` | Data that plugins store |
| `plugin-files` | The plugins' files |

The seventh volume, `ai-tools`, holds the installed AI tools. The backup leaves it out, because [`aphelion tool install`](#install-an-ai-tool) rebuilds it from the list. A tool's sign-in is in `bots`, which the backup holds. After a restore, install each tool you use again, and you stay signed in.

You keep two things, in two places:

- The recovery copy of the bootstrap key, in your password manager. [Keep a recovery copy of the bootstrap key](#keep-a-recovery-copy-of-the-bootstrap-key) makes it.
- The archive of the six volumes.

The archive holds the database and the bot folders as plain files. Only the `secrets` volume inside it is encrypted, by the bootstrap key. Store the archive on encrypted storage, and keep it apart from the key's copy. Someone who has both reads every secret.

`tar` is a program that packs a folder into one file. Aphelion runs it in a short-lived container made from the same image as the server, so nothing is downloaded.

### Back up

1. Run the backup. It stops the service, packs the six volumes into an archive, writes a checksum (a short fingerprint that shows later whether the file changed or broke in a copy), starts the service again, and checks the archive against the checksum. It prints the folder it made. It starts the service again even when the backup fails.

   ```sh
   sudo aphelion backup
   ```

   You should see one line, such as `/var/backups/aphelion/aphelion-backup-20261123-120000`. The folder holds `aphelion-data.tar.gz` and `aphelion-data.tar.gz.sha256`, and only root can read it. A link named `latest` in `/var/backups/aphelion` points at the newest backup. Each run makes a new folder and keeps the one before it, so a backup that fails never destroys the last good one. Older folders are deleted. To write somewhere else, use `sudo aphelion backup --to FOLDER`.

2. Copy the archive and its checksum file off the host, for example to a machine you can reach with `ssh`. The command makes a new folder named after the date and time, which only you can read, and prints its name. A failed copy never replaces an older backup, because each copy gets its own folder.

   ```sh
   d=aphelion-backup-$(date +%Y%m%d-%H%M%S) && sudo tar --create --directory /var/backups/aphelion/latest --file - aphelion-data.tar.gz aphelion-data.tar.gz.sha256 | ssh you@backup-machine "umask 077 && mkdir $d && tar --extract --directory $d --file -" && echo "$d"
   ```

3. Check the copy on the backup machine. Put the folder name that step 2 printed in place of `aphelion-backup-20261123-120000`. You should see `aphelion-data.tar.gz: OK`. Only `OK` means the backup is ready. If you see anything else, the copy or the `ssh` connection failed. Run step 2 again.

   ```sh
   ssh you@backup-machine 'cd aphelion-backup-20261123-120000 && sha256sum --check aphelion-data.tar.gz.sha256'
   ```

#### What the backup runs underneath

`aphelion backup` runs these steps as root, from `/opt/aphelion/deploy`. `docker compose config --images` gives the image name, `aphelion:local` on a real host.

```sh
sudo systemctl stop aphelion
sudo docker run --rm --pull never --network none --entrypoint "" \
  -v aphelion_config:/data/config:ro \
  -v aphelion_state:/data/state:ro \
  -v aphelion_bots:/data/bots:ro \
  -v aphelion_secrets:/data/secrets:ro \
  -v aphelion_plugin-data:/data/plugin-data:ro \
  -v aphelion_plugin-files:/data/plugin-files:ro \
  -v /var/backups/aphelion/aphelion-backup-20261123-120000:/backup \
  aphelion:local \
  tar --create --gzip --numeric-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data .
sudo sh -c 'cd /var/backups/aphelion/aphelion-backup-20261123-120000 && sha256sum aphelion-data.tar.gz > aphelion-data.tar.gz.sha256'
sudo systemctl start aphelion
```

### Restore on the new host

Start from a host that has the bootstrap key in `/etc/credstore.encrypted/aphelion-bootstrap` ([Restore on new hardware](#restore-on-new-hardware)) and has finished the installer with `--no-start`, or [Install step by step](#install-step-by-step) steps 1 to 4. The service must not have started. The first start creates empty volumes, and the secrets broker writes a new store in them.

1. Put the archive and its checksum file in a private folder on the new host. For example, run these on the new host to fetch them from the backup machine. Put the name of the backup folder in place of `aphelion-backup-20261123-120000`.

   ```sh
   sudo install -d -m 0700 /var/backups/aphelion/from-backup-machine
   ```

   ```sh
   ssh you@backup-machine 'tar --create --directory aphelion-backup-20261123-120000 --file - aphelion-data.tar.gz aphelion-data.tar.gz.sha256' | sudo tar --extract --no-same-owner --directory /var/backups/aphelion/from-backup-machine --file -
   ```

2. Run the restore with the folder.

   ```sh
   sudo aphelion restore /var/backups/aphelion/from-backup-machine
   ```

   The command works in this order:

   1. It checks the archive against its checksum, and stops if they differ.
   2. It stops the service if it runs.
   3. It refuses if any of the six Aphelion volumes already exists. Restoring over them would mix old and new files. It prints the commands that remove them, and removes nothing itself. Run them only if the volumes hold nothing you need, then run the restore again.
   4. It creates the six volumes with the labels that Compose puts on its own, so Compose doesn't warn that it didn't create them.
   5. It unpacks the archive into them.
   6. It finishes the restore. This revokes every device token in the restored database and switches every plugin off, so the server starts with nobody enrolled and no plugin running. A backup can be old, and a device you removed since then comes back with it. The step doesn't need the bootstrap key.
   7. It starts the service, only if step 6 worked. If a step fails, the command says so and leaves the service stopped.

   Without a folder, `sudo aphelion restore` uses the `latest` backup in `/var/backups/aphelion`. You can also give the path of an archive file.

   Step 6 prints one line for each plugin, with the command that switches it on, and then the command that enrolls a device. For the test data you should see:

   ```text
   Restore finished. Every device token is revoked.
   Plugin aphelion-test-plugin is switched off. Switch it on: aphelion plugin enable aphelion-test-plugin
   Enroll a device: aphelion device add NAME
   Started aphelion.
   ```

   Don't start the service by hand before `Restore finished` appears. If step 6 fails, the restored tokens and plugins are still live, so the service stays stopped. To start over, run the commands that the failure message prints, which remove the volumes, and run the restore again.

Then enroll a device and switch each plugin back on with the commands that the restore printed ([Check the restore](#check-the-restore) shows them).

If the key doesn't match the restored `secrets` volume, the container exits and systemd tries again every 10 seconds. `sudo aphelion logs` shows `The bootstrap key does not match this secrets store`. The key and the archive came from different installs. Stop the service with `sudo systemctl stop aphelion`, put the right key in place with [Restore on new hardware](#restore-on-new-hardware) steps 2 to 4, and start it again. The volumes stay as they are.

A plugin can come back in two ways. Restoring `plugin-files` brings its files back as they were. You can also install it again and skip `plugin-files`. Either way, the plugin starts switched off, because the restore switches it off in step 2. Its approval stays in the database and records the plugin's folder, and a digest of its files. `aphelion plugin enable` shows the permissions it already has and, when you approve, switches it on. The digest is a fingerprint made from each file's path inside the plugin folder and its contents, and [the plugin reference](../reference/plugins.md#permissions) describes it. A plugin that you install again must go in the same folder, with the same files, byte for byte. A file that differs in one byte stops `plugin enable`, and you approve the plugin again with [Install a plugin](#install-a-plugin). The `plugin-data` volume holds data that a plugin stores, and a new install doesn't recreate it, so restore that volume either way.

#### What the restore runs underneath

`aphelion restore` runs these steps as root, from `/opt/aphelion/deploy`:

```sh
sudo systemctl stop aphelion
sudo docker volume ls --quiet --filter name=aphelion_
for v in config state bots secrets plugin-data plugin-files; do
  sudo docker volume create --label com.docker.compose.project=aphelion --label com.docker.compose.volume=$v aphelion_$v
done
sudo docker run --rm --pull never --network none --entrypoint "" \
  -v aphelion_config:/data/config \
  -v aphelion_state:/data/state \
  -v aphelion_bots:/data/bots \
  -v aphelion_secrets:/data/secrets \
  -v aphelion_plugin-data:/data/plugin-data \
  -v aphelion_plugin-files:/data/plugin-files \
  -v /var/backups/aphelion/from-backup-machine:/backup:ro \
  aphelion:local \
  tar --extract --gzip --numeric-owner --same-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data
sudo docker run --rm --pull never --network none --entrypoint "" --user harness \
  -v aphelion_state:/var/lib/aphelion \
  aphelion:local \
  aphelion restore finish
sudo systemctl start aphelion
```

The project name comes from `COMPOSE_PROJECT_NAME`, and is `aphelion` when that is unset.

### Check the restore

Run three checks from `/opt/aphelion/deploy` once the service has started. They use the test data from [Rehearse with test data](#rehearse-with-test-data). After a real restore, check a plugin and a device that you know, and check a real secret by using the feature that needs it. Never type a real secret's value into a command.

1. A secret reads back. No `aphelion` command reads a secret, so this asks the secrets broker through Bun, the program inside the image that runs the server. It prints the broker's status code, and then `true` if the value matches. You should see `200 true`.

   ```sh
   sudo docker compose exec -T --user harness aphelion bun -e 'const r = await fetch("http://broker/v1/local", {unix: "/run/aphelion-secrets/broker.sock", method: "POST", body: JSON.stringify({op: "read", ref: "local://drill/test"})}); console.log(r.status, r.ok && (await r.json()) === "drill-value-not-a-real-secret")'
   ```

2. A plugin comes back switched off, and you switch it on. First check that it didn't start. You should see `plugin host started` with `"installed":1`, the line `a switched-off plugin was not started`, and no `aphelion-test-plugin 1.0.0 started`.

   ```sh
   sudo aphelion logs --since "10 minutes ago" | grep -E 'plugin host started|switched-off|aphelion-test-plugin'
   ```

   Preview the plugin, then repeat the command with the `--approve` value it printed. You should see `Switched on aphelion-test-plugin. It runs.`

   ```sh
   sudo aphelion plugin enable aphelion-test-plugin
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

4. Copy the folder into the container, and preview its permissions.

   ```sh
   sudo aphelion plugin install ~/aphelion-test-plugin
   ```

5. Repeat the command with the `--approve` value it printed. You should see `Plugin approved.`

   ```sh
   sudo aphelion plugin install ~/aphelion-test-plugin --approve <value>
   ```

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

Plugins live in the `plugin-files` volume. A volume is a folder that Docker keeps for the container, and it survives an image rebuild. The container sees this one at `/opt/aphelion/plugins`. Plugins can read it, but can't change it. Run these steps while the service runs.

1. Unpack the plugin into a folder named after it, then make every file readable by everyone and writable only by you.

   ```sh
   chmod -R a+rX,go-w <name>
   ```

2. Preview its permissions. The command copies the folder into the volume, where Docker gives the copy to `root`, so the plugin can't change its own files. It refuses a folder name that holds anything but letters, digits, dots, dashes and underscores, and a plugin that is already in the volume. To change an installed plugin, use [Update a plugin](#update-a-plugin).

   ```sh
   sudo aphelion plugin install <name>
   ```

3. If you accept the permissions, repeat the command with the `--approve` value it printed. The command doesn't copy the folder a second time. The approval covers every file in the folder, so approve again after any file changes.

   ```sh
   sudo aphelion plugin install <name> --approve <value>
   ```

4. Restart the service. The server starts every approved plugin when it starts. The command prints this step when the approval worked.

   ```sh
   sudo systemctl restart aphelion
   ```

Underneath, steps 2 and 3 run these commands from `/opt/aphelion/deploy`:

```sh
sudo docker compose cp <name> aphelion:/opt/aphelion/plugins/<name>
sudo docker compose exec -T --user harness aphelion aphelion plugin install /opt/aphelion/plugins/<name>
```

[Running plugins on the server](../reference/plugins.md#permissions) explains the approval. To write a plugin, see [Write your first server plugin](write-your-first-server-plugin.md).

## Update a plugin

A plugin whose manifest names a GitHub `repository` updates from that repository's releases. Aphelion checks that GitHub's release workflow built each release, and installs it only after you approve it. The server keeps running while the plugin switches version. Run these steps while the service runs.

1. Check for a newer release and preview it. Use the plugin's `id`, such as `aphelion-test-plugin`.

   ```sh
   sudo aphelion plugin update <id>
   ```

   When the latest release is the installed version, the command prints `<id> is already on <version>, the latest release. If the server still runs an older version, run aphelion plugin restart <id>.` and you are done. The server can still run an older version if an earlier `--approve` run stopped after it installed the release and before it restarted the plugin. In that case, run `sudo aphelion plugin restart <id>`. If the latest release is not the installed version, the command prints the two versions, the permissions the new version adds or drops, and an `--approve` value.

2. If you accept the changes, repeat the command with the `--approve` value it printed.

   ```sh
   sudo aphelion plugin update <id> --approve <value>
   ```

   The command installs the release and restarts the plugin on it. It prints `Updated <id> from <old version> to <new version>.` and then `<id> <new version> runs.`

If the new version doesn't start, Aphelion goes back to the old version on its own, says so, and exits with code 1. The server log says why the new version stopped.

The command refuses a release that GitHub's attestation doesn't vouch for, with one sentence that says why. Nothing changes, and the running version keeps running. [Updates](../reference/plugins.md#updates) lists every check and limit.

## Go back a version

Aphelion keeps the version before the current one. To go back to it, run:

```sh
sudo aphelion plugin rollback <id>
```

The command prints `Went back from <id> <current version> to <earlier version>.` and then `<id> <earlier version> runs.` It deletes the version it left, so you can go back only once. To return to the newer version, [update the plugin](#update-a-plugin) again.

## Install an AI tool

The container image has no AI tool in it. Aphelion keeps a list of four tools, Claude Code, Codex, Grok Build and OpenCode, each pinned to one version. You install the ones you use. The list is [`deploy/ai-tools.json`](https://github.com/jcore9/Aphelion/blob/main/deploy/ai-tools.json). Each entry has the download address, the file's size and its **SHA-256**, a fingerprint that changes if one byte of the file changes. The install refuses a file whose SHA-256 or size differs from the list, and it refuses any name that isn't on the list.

Tools live in the `ai-tools` volume, which the container sees at `/opt/aphelion/tools`. Bots can run what is in it, but can't change it. The volume survives an image rebuild. Run these steps while the service runs.

1. See the list. `VERSION` is the version the list pins, and `INSTALLED` is the version in the volume, or `-` when there is none. `STATE` is `installed`, `update available`, `not installed`, or `unavailable` when the tool has no build for this processor.

   ```sh
   sudo aphelion tool list
   ```

2. Install a tool. Use the name from the first column.

   ```sh
   sudo aphelion tool install claude
   ```

   The command downloads the file, checks it, and prints `Installed claude <version>.` and the command that signs in. If the checksum or size is wrong, it installs nothing and says what differed. Running the command again for the installed version changes nothing, and running it after an interrupted install finishes the job.

3. Sign in. The command runs the tool's own sign-in as the `aphelion-bot` user, on your terminal, so the tool's prompts and links show on your screen. Run it in a shell on the host, not through a pipe or a script, because it refuses without a terminal. It refuses a tool that isn't installed.

   ```sh
   sudo aphelion sign-in claude
   ```

   The tool's own sign-in is `claude auth login`, `codex login --device-auth`, `grok login --device-auth` or `opencode auth login`. Aphelion never reads, copies or logs what the tool prints, such as a code or a token ([decision 0019](../decisions/0019-cli-subscription-use.md)). The login stays in the `bots` volume, which the backup holds. Underneath, the command runs `docker compose exec --user aphelion-bot aphelion <the tool's sign-in command>` from `/opt/aphelion/deploy`.

4. Check the result. `sudo aphelion status` lists each installed tool and whether it is signed in. Grok Build and OpenCode show `sign-in state unknown`, because Aphelion has no command that checks them.

The tools' own auto-update is off. Claude Code and Codex are switched off in the image. Grok Build and OpenCode have a setting (`--no-auto-update` and `"autoupdate": false`) that Aphelion applies when the bot adapters for them arrive in M4. A new version reaches the container only through a new entry in the list.

**What the Grok Build checksum proves.** xAI publishes no checksum for Grok Build. The bot downloaded the file from both of xAI's addresses, saw that the two copies matched, and recorded their SHA-256 in the list, and you approved that when you merged the change. The install proves that the file hasn't changed since. It doesn't prove that the first copy came from xAI. [Decision 0066](https://github.com/jcore9/Aphelion/blob/main/docs/decisions/0066-grok-checksum-recorded-by-aphelion.md) has the reasoning.

## Use an API key instead of a sign-in

This step is optional. An **API key** is a long password from an AI vendor's developer console. A tool that runs on a key bills each request to that vendor account, instead of using your subscription. You can store a key now, but bots don't use it yet: the change that hands the key to a bot at start is still to come ([#181](https://github.com/jcore9/Aphelion/issues/181)). When it comes, a working sign-in still wins over a key.

| Tool | Key it takes |
| --- | --- |
| `claude` | An Anthropic API key |
| `codex` | An OpenAI API key |
| `grok` | An xAI API key |

OpenCode signs in to many vendors, so it has no single key. Use `sudo aphelion sign-in opencode` for it.

1. Store the key. Run it in a shell on the host. Paste the key when it asks, and press Enter. The key doesn't show on the screen.

   ```sh
   sudo aphelion key add claude
   ```

   It prints `Stored the claude API key.` The broker keeps the key encrypted in the `secrets` volume, which the backup holds. The key never goes on a command line, into a log or into the audit log.

2. Test the key. The command asks the vendor to list its models with the key, which costs nothing.

   ```sh
   sudo aphelion key test claude
   ```

   `The provider accepted the claude API key.` means the key works. `The provider refused the claude API key.` means the vendor doesn't accept it: check that you copied all of it, and that it is still active in the vendor's console.

To change a key, run `sudo aphelion key replace claude`. To delete it, run `sudo aphelion key remove claude`. [The host command](../reference/host-command.md#key) has the details.

## Update an AI tool

A tool's version changes only when the list changes. You see whether a newer version exists, you approve it, and then you apply it. Each step is its own command.

1. Ask the vendors what their newest version is.

   ```sh
   sudo aphelion tool check
   ```

   The command asks each vendor for the name of its newest release and downloads no program. It prints one line per tool:

   ```text
   NAME      PINNED    LATEST    STATE
   claude    2.1.330   2.1.332   newer version available
   codex     0.172.0   0.172.0   current
   grok      1.0.92    1.0.92    current
   opencode  2.4.1     2.4.1     current
   ```

   `PINNED` is the version in the list. `STATE` is `current`, `newer version available`, or `unknown` when the vendor didn't answer within 10 seconds or its answer wasn't a version number. The reason for an `unknown` goes to standard error. The command exits with 0 when it ran, even when a newer version exists, and with 1 when the list can't be read or no vendor gave a version number. It needs no tool to be installed.

   Claude Code and Grok Build publish a small file with their newest version (Claude Code's `latest` file, Grok Build's `stable` file). Codex and OpenCode publish releases on GitHub, and Aphelion reads the newest release that is not a prerelease. For OpenCode that is the highest plain version among its ten newest releases, because the release GitHub marks as its latest is an old one.

2. Approve the new version. A newer version reaches your server only through a new entry in the list, [`deploy/ai-tools.json`](https://github.com/jcore9/Aphelion/blob/main/deploy/ai-tools.json). Whoever proposes the entry runs [`scripts/verify-ai-tools.ts`](https://github.com/jcore9/Aphelion/blob/main/scripts/verify-ai-tools.ts), which checks the new download address, size and SHA-256 against the vendor's own pages. The change lands only when the owner approves it ([decision 0063](https://github.com/jcore9/Aphelion/blob/main/docs/decisions/0063-m1-planning-answers.md)). The list is part of the image, so upgrade Aphelion after it lands ([Upgrade](#upgrade)).

3. See what changed. A tool installed at a different version than the list pins now shows `update available`, with both versions.

   ```sh
   sudo aphelion tool list
   ```

   ```text
   NAME    VERSION  INSTALLED  STATE             STATUS-COMMAND            SIGN-IN-COMMAND
   claude  2.1.332  2.1.330    update available  claude auth status --text  claude auth login
   ```

   `sudo aphelion status` adds `(update available: 2.1.330 -> 2.1.332)` to the tool's line.

4. Apply the update. Name one tool, or leave the name out to update every installed tool.

   ```sh
   sudo aphelion tool update claude
   ```

   The command makes the same checks as `tool install`. It prints one line per tool:

   | Line | Meaning |
   | --- | --- |
   | `updated claude 2.1.330 -> 2.1.332` | The new version is installed and the old version's files are deleted. |
   | `claude is up to date (2.1.332)` | The installed version is the list's version. Nothing changed. |
   | `claude isn't installed` | The command updates only tools that are installed. Use `tool install` for the first install. |
   | `claude has no build for this processor` | The list has no download for this processor. |

   A bot that is running the old version keeps running it until it restarts. Running the command again changes nothing. If a download fails a check, the old version stays installed and keeps working, and the command exits with 1.

**Why the tools' own updaters stay off.** Claude Code and Codex can replace their own program. Aphelion switches that off. The updater would put in a file that Aphelion never checked against a SHA-256, and the tools' folder is read-only to the bots, so the updater couldn't write there anyway. Going through the list means every program that runs on your server is one you approved and Aphelion verified. [Install an AI tool](#install-an-ai-tool) says how each tool is switched off.

## Remove an AI tool

```sh
sudo aphelion tool remove <name>
```

The command deletes the tool's files from the `ai-tools` volume and prints `Removed <name>.` A second run prints `<name> isn't installed.` The tool's sign-in stays in the `bots` volume. To sign out too, delete the hidden folder the tool made in the `aphelion-bot` user's home, `/var/lib/aphelion-bots`, such as `.claude`, `.codex` or `.grok`.

## Check the network boundary

The container must not reach your LAN, the host or other tailnet devices ([decision 0022](../decisions/0022-bot-network-boundary.md)).

To check that the firewall rules are still in place, run `aphelion network-check` with no targets:

```sh
sudo aphelion network-check
```

With no targets, the command reads the firewall without sending traffic. It checks Aphelion's `APHELION-FORWARD` and `APHELION-INPUT` chains and rules, the jump rules in `FORWARD` and `INPUT`, the IPv6 drop rules, Docker's `filter` and `nat` `DOCKER` chains, and ufw's `MANAGE_BUILTINS` setting. It prints `ok` for each passing check and `FAIL` naming each missing rule or chain. Run it after a `sudo ufw reload` or `sudo ufw enable` to confirm no rule was lost. `sudo aphelion check` runs the same read-only firewall check.

To also test connections from inside the container, pass six targets in this order:

1. Your LAN gateway, such as your router.
2. The host's LAN address.
3. The host's tailnet address.
4. Another device on your tailnet.
5. The bridge gateway, which is `172.30.73.1` by default.
6. A host on the internet.

Each target is an address and an open port. For example:

```sh
sudo aphelion network-check 10.0.0.1:80 10.0.0.133:22 100.71.226.67:22 100.93.139.95:22 172.30.73.1:22 1.1.1.1:443
```

The command runs the read-only firewall check first. Next, it connects to each target from the host itself, and stops if a target doesn't answer, so pick targets with an open port. Then it connects to each target as `aphelion-bot` inside the running container. The first five must print `blocked`. That means the connection from the container timed out, because the firewall dropped it. A target that refuses the connection also fails the check, because the refusal came back from that target. The sixth must print `reachable`, and names must resolve. The command exits with code 1 if any check fails, and with code 2 if a target is malformed, the host can't reach a target, or the container isn't running. Underneath, it runs [`deploy/host/network-check`](https://github.com/jcore9/Aphelion/blob/main/deploy/host/network-check).

Aphelion refuses to start when ufw is enabled and `MANAGE_BUILTINS=yes` is set in `/etc/default/ufw`. To fix this, set `MANAGE_BUILTINS=no` in that file, then run these commands.

```sh
sudo ufw reload
sudo systemctl restart docker
```

Docker rebuilds its chains, and `aphelion.service` restarts with it and installs Aphelion's rules. Once Aphelion runs again, run `sudo aphelion network-check` above.

Preflight runs only when Aphelion starts. If you set `yes` later, while Aphelion runs, the next `sudo ufw reload` or `sudo ufw enable` removes Aphelion's rules and Docker's chains. They stay gone until you fix the setting and restart Docker as above. Restarting Aphelion alone doesn't bring them back. Make sure `MANAGE_BUILTINS=no` is set before you run either command. Preflight reads `/etc/default/ufw` the way ufw does, so if it sets `MANAGE_BUILTINS` more than once, the last line counts.

The M0 exit test tried two `ufw` settings on Ubuntu 26.04 with Docker 29.10, with ufw turned on:

- With ufw's default setting, `MANAGE_BUILTINS=no` in `/etc/default/ufw`, `sudo ufw reload` left Aphelion's rules in place, and the check still passed.
- With `MANAGE_BUILTINS=yes`, `sudo ufw reload` removed the rules that send traffic into Aphelion's chains, and deleted Docker's own `DOCKER` chain. `sudo aphelion network-check` names those missing jumps and chains. The six-target check showed the container connecting to the host's LAN, tailnet and bridge addresses, and failing to reach `1.1.1.1:443`. Restarting `aphelion` didn't help. `sudo aphelion logs` showed this line every 10 seconds:

  ```text
  failed to set up container networking: ... iptables failed: iptables --wait -t filter -I DOCKER ... iptables: No chain/target/match by that name.
  ```

Reloading a file that contains `flush ruleset`, such as `/etc/nftables.conf`, can clear Docker's and Aphelion's rules too, when `iptables` uses the nftables backend. This wasn't tested. After such a reload, restart Docker the same way and run `sudo aphelion network-check` again.

## Logs

Show the last 100 lines of the service logs:

```sh
sudo aphelion logs --lines 100
```

Without flags, `sudo aphelion logs` prints the whole journal from every restart and boot. You can combine three flags to narrow the output:

- `--follow` keeps printing new lines as they arrive, until you press Ctrl-C.
- `--lines N` shows only the last `N` lines, where `N` is a positive whole number.
- `--since TIME` shows lines from `TIME` onward, such as `"1 hour ago"` or `"2026-11-27 00:00:00"`.

```sh
sudo aphelion logs --follow --lines 50
sudo aphelion logs --since "1 hour ago"
```

Underneath, the command runs `journalctl -u aphelion --no-pager` with the flags you gave. It never reads or prints `deploy/.env` or the bootstrap credential. The launcher, the server, the broker, the plugin runner and the plugins all log to the same stream.

## Upgrade

Move the server to the newest release:

```sh
sudo aphelion upgrade
```

To move to one release tag from [the releases page](https://github.com/jcore9/Aphelion/releases), pass the tag name:

```sh
sudo aphelion upgrade v0.1.0-alpha.2
```

If `sudo aphelion upgrade` prints `command not found` or the usage text, this server's release is older than the command. Run the steps in [First upgrade from an older release](#first-upgrade-from-an-older-release) once. After that, `sudo aphelion upgrade` works.

The command works in this order:

1. It checks `/opt/aphelion` and stops if it is a symbolic link, has a file that root doesn't own or others can write, has an origin other than `https://github.com/jcore9/Aphelion.git`, or has local changes.
2. With no tag, it asks GitHub for the newest published release. That includes pre-releases while Aphelion is before v1.0.
3. It checks whether `/opt/aphelion` is already on that tag. If it is, and `aphelion.service` is enabled and running and `/health` answers, the command prints `Aphelion is already at <tag>.` and exits without changing anything. If `/opt/aphelion` is on that tag but the service isn't enabled and running or `/health` doesn't answer, it skips the checkout and runs steps 4 to 6. Otherwise it fetches tags from GitHub, stops if the tag doesn't exist, and checks out the tag.
4. It runs `host/get-image` from the checked-out release. If the release has an `aphelion-image.sha256` file, that script downloads the image by its digest, checks that the fingerprint matches, and tags it as `aphelion:local`. If the release has no digest file, or the download fails because the image package is private, it builds `aphelion:local` on the server instead.
5. It runs `host/install`, which updates the unit file and keeps the existing bootstrap key. If step 4 or step 5 fails, for example on a digest mismatch or a rejected bootstrap key, `upgrade` puts `aphelion:local` back on its earlier image, or removes the new tag when there was none. If step 3 moved `/opt/aphelion`, it also puts `/opt/aphelion` back on its earlier branch or commit.
6. It restarts `aphelion` and prints the version before and after, or that it finished upgrading to that tag. It then prints `Waiting up to 5 minutes for the server to answer...`, waits up to 300 seconds for `/health`, and runs `aphelion check`. If the restart fails, it prints the log command and, when it moved from an earlier release tag, the command to go back. If the upgrade finishes but `aphelion check` fails, it says so and exits with 1.

### First upgrade from an older release

`v0.1.0-alpha.1` has no `aphelion` command, so `sudo aphelion upgrade` prints `command not found`. A server built from `main` before this command prints the usage text instead. The one-line installer refuses to move a running server to a different tag, so in both cases run these steps once. After that, `sudo aphelion upgrade` works.

1. Find the newest tag on [the releases page](https://github.com/jcore9/Aphelion/releases), and put it in `tag`.
2. Fetch tags and check out that release in `/opt/aphelion`.
3. Download or build the image with `host/get-image`, update the service and command with `host/install`, and restart `aphelion`.
4. Run `sudo aphelion check` to confirm the server is up. If `/health answers on the tailnet address` fails right after the restart, wait a minute and run `sudo aphelion check` again.

```sh
tag=v0.1.0-alpha.2
cd /opt/aphelion &&
	sudo git fetch --tags &&
	sudo git checkout --detach "refs/tags/$tag" &&
	cd deploy &&
	sudo host/get-image "$tag" &&
	sudo host/install &&
	sudo systemctl restart aphelion &&
	sudo aphelion check
```

`aphelion upgrade` runs those same steps underneath. `host/get-image` pulls and checks the published image, or builds it with `docker compose build` when the package is private or has no digest file.

If you upgrade from a version that kept plugins in `/opt/aphelion/deploy/plugins`, install each plugin again. That version mounted the host folder. This one keeps plugins in the `plugin-files` volume, and it checks every file of a plugin, so earlier approvals don't carry over. For each folder in `/opt/aphelion/deploy/plugins`, follow [Install a plugin](#install-a-plugin) from step 2. Until you do, the server doesn't start that plugin. Then you can delete `/opt/aphelion/deploy/plugins`. If the service then stops and the log shows `The secrets store holds a plain-text key from before the host credential`, see [Start a fresh store after an older install](#start-a-fresh-store-after-an-older-install). The volumes keep the config, the database, the bot folders, the secrets store and the plugin data.
