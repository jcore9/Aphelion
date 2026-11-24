# M0 exit test results

The owner ran the [M0 exit test](M0-foundations.md#exit-test) by hand on 2026-11-24, from `dev` at commit 5d31a46. The install ran on a Proxmox virtual machine (VM), VM A. The test is tracked in [issue #187](https://github.com/jcore9/Aphelion/issues/187). The result is a pass, with four documentation fixes. Secrets, tokens and sign-in codes are left out of this page.

## Results

VM A is the machine the server was installed on. The restore drill moved its data to a second machine, VM B.

| Step | What was checked | Result |
| --- | --- | --- |
| 0. Host | Ubuntu, Docker, Compose and Tailscale on VM A | Pass. Ubuntu 26.04.1 LTS on x86-64, Docker 29.10.0, Compose 5.8.0, Tailscale 1.104.7. The user is in `sudo`, not in `docker`. |
| 1. Install | Build the image, run `host/install`, make the recovery copy, start the service | Pass after one fix. The first build failed with `this CPU is missing SSE4.2 support, which Bun requires.` The Proxmox CPU type was changed to `host`, and the build passed (F1). `host/install` printed a warning about `credential.secret` not being on encrypted media (F2). The service started, and `/health` answered from another tailnet device. |
| 2. Enabled, reboot | `systemctl is-enabled aphelion`, then reboot | Pass. It reports `enabled`, and the service came back after the reboot. |
| 3. `/health` | Request from the tailnet and from the LAN | Pass. The tailnet request returned `200` and `{"status":"ok"}`. The request to the host's LAN address timed out. |
| 4. WebSocket | Open `/ws` without and with a device token | Pass. Without a token: `401 Unauthorized`. With a token from `device add`: `101 Switching Protocols`. |
| 5. Users in the container | Whether any of the four users has `sudo`, plus the expected access and refusal checks | Pass. No user has `sudo`. Every allowed access worked and every refusal held. The step names managed hooks and the bot runner, which M0 doesn't have (F3). |
| 6. `docker inspect` | Hardening settings and mounts | Pass. Output: `true false ["ALL"] ["CAP_KILL","CAP_SETGID","CAP_SETUID"] ["no-new-privileges:true"]`. No Docker socket is mounted. |
| N1. network-check | `host/network-check` with five blocked targets and one allowed | Pass. The five blocked targets were blocked, `1.1.1.1:443` was reachable and names resolved. The first run used the Proxmox host as the tailnet peer, so it was rerun with a real tailnet peer. The Proxmox host was blocked too. |
| N2. ufw reload | Reload `ufw` with `MANAGE_BUILTINS=yes`, then restart. Reload with `MANAGE_BUILTINS=no`, with no restart | Found a problem (F4). See below. |
| 7. Restore drill | Back up on VM A, restore on VM B, run the three checks | Pass. All three checks passed. See below. |
| Claude sign-in (extra) | Sign in to Claude Code as `aphelion-bot` | Works. See [Claude sign-in inside the container](#claude-sign-in-inside-the-container). |

### ufw reload

`ufw` is Ubuntu's firewall front end. Its `MANAGE_BUILTINS` setting decides whether it also rewrites the built-in firewall chains that Docker and Aphelion use.

- With `MANAGE_BUILTINS=yes`, `ufw reload` removed two of Aphelion's firewall rules: the count of its rules fell from 18 to 16. Those two are inferred to be the jumps that send traffic into Aphelion's chains. `network-check` then showed the container connecting to three of the host's own addresses, and timing out to `1.1.1.1:443`. The likely cause is that `ufw` dropped all forwarded traffic once Docker's rules were gone, so two of the "blocked" results were probably blocked for the wrong reason (inferred).
- The reload also deleted Docker's own `DOCKER` chain. `systemctl restart aphelion` then failed on every try with `Unable to enable OPEN PORT rule` and `No chain/target/match by that name`. The restart counter reached 20.
- `systemctl restart docker` fixed it. Docker's chains came back, Aphelion's rules came back, and `/health` answered. Preflight, the check Aphelion runs before it starts, reported the firewall as fine and did not notice that Docker's chains were gone.
- With `MANAGE_BUILTINS=no`, which is `ufw`'s default, a reload with no restart left everything in place. `network-check` and `/health` passed.

### Restore drill

The drill used test data only. On VM A the tester wrote a test secret, added the device `drill-laptop`, and installed and approved the test plugin `aphelion-test-plugin`. Then the service was stopped and its data archived. The archive's checksum was verified with `sha256sum` on the backup machine. The archive was restored on VM B with VM A's bootstrap key. The three checks:

| Check | Result |
| --- | --- |
| The test secret reads back | Pass. `200 true`. |
| The test plugin starts with no new approval | Pass. The log shows installed, starting, then running, and `aphelion-test-plugin 1.0.0 started`. |
| The test device is in the database | Pass. `device list` shows `drill-laptop` with the same ID and expiry as on VM A. |

`/health` also answered on VM B.

## Deviations

- **VM A doubled as drill VM A.** The same machine ran the install checks and the first half of the restore drill.
- **VM B was not a fresh VM.** It was an existing Ubuntu 24.04.5 machine that runs other containers. The plan asked for a fresh 26.04 VM. The owner chose to continue on it.
- **The backup was on VM B.** VM B was also the backup machine, so the archive was copied locally instead of fetched over `ssh`. The `sha256sum` check passed.
- **No TPM.** The host has no TPM (trusted platform module, a chip that can seal keys). The TPM checks don't apply.

## Findings

Each finding is a documentation fix unless noted. [PR #189](https://github.com/jcore9/Aphelion/pull/189) fixes all four.

| # | Finding |
| --- | --- |
| F1 | The install guide doesn't name the CPU requirement. Bun needs x86-64 with SSE4.2, so a Proxmox VM needs a CPU type that passes it through. `host` was tested. `x86-64-v2-AES` wasn't. |
| F2 | The guide doesn't explain the `credential.secret` warning from `host/install`. It is the host-key-only case that [decision 0050](../../decisions/0050-bootstrap-key-is-the-store-key.md) accepts. |
| F3 | Exit test step 5 names managed hooks and the bot runner. Neither exists in M0. The checks that stood in were the read-only `/etc` and the plugin runner's pipe. |
| F4 | With `MANAGE_BUILTINS=yes`, `ufw reload` deletes Docker's `DOCKER` chain, and "restart the service" can't recover. The fix is `systemctl restart docker`. A script fix may also be needed, because preflight doesn't notice the missing chains. |

The owner also gave feedback. The first note is on [#178](https://github.com/jcore9/Aphelion/issues/178): setup takes too many steps and needs to be easier than a script. The feedback called for fewer steps, a processor check and one command to run the checks. The second asks to revisit running on one computer without Docker, which [#188](https://github.com/jcore9/Aphelion/issues/188) tracks for M9.

## Claude sign-in inside the container

The [M0-24 spike](../../spikes/M0-24-sign-in-from-the-app.md) left open whether sign-in works inside the container as `aphelion-bot`. The exit test ran it on VM B, after the drill, with Claude Code 2.1.331.

1. Before: `claude auth status --text` printed `Not logged in` and exited with 1.
2. `claude auth login` as `aphelion-bot` printed a link. The owner opened it on a laptop and pasted the code back. Result: `Login successful.`
3. After: `loggedIn: true` and `authMethod: claude.ai`.
4. The file `~/.claude/.credentials.json` is owned by `aphelion-bot`, group `aphelion-bot`, mode 600, 695 bytes. `harness` and `aphelion-plugins` can't read it. It lives in the `bots` volume.
5. `claude -p "Reply with just the word ok"` as `aphelion-bot` answered `ok`.
6. `claude auth logout` signed out, and `auth status` exited with 1 again.

Sign-in works with the subscription paste-code flow. It is determined for Claude only. Grok and Codex stay undetermined.

**Note for the M1 adapter.** `claude -p` printed `Warning: no stdin data received in 3s, proceeding without it.` With `docker compose exec -T`, stdin is open but empty, so Claude waits 3 seconds. The adapter should pass `< /dev/null` or its own input.
