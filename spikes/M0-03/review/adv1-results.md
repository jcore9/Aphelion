# adv1 adversarial run: captured output

Run from `spikes/M0-03`. Project `adv1`, image `aphelion-adv1`, ports 7410 and 7411 on 100.71.226.67.
Each network target got exactly one connect attempt (3 s timeout) and no data was sent.
Commands are shown with `sg docker -c` omitted for brevity.

## Claim 3: connect from the agent uid (10002), one attempt per target

    docker compose -p adv1 -f docker/compose.yaml exec -T -u 10002 variant-a /usr/local/bin/aphelion-stub netprobe <host> <port>

    10.0.0.1 uid=10002 gid=10002 -> 10.0.0.1:80 CONNECTED
    10.0.0.133 uid=10002 gid=10002 -> 10.0.0.133:22 CONNECTED
    100.71.226.67 uid=10002 gid=10002 -> 100.71.226.67:22 CONNECTED
    100.93.139.95 uid=10002 gid=10002 -> 100.93.139.95:22 CONNECTED
    172.17.0.1 uid=10002 gid=10002 -> 172.17.0.1:22 CONNECTED
    1.1.1.1 uid=10002 gid=10002 -> 1.1.1.1:443 CONNECTED

Intent: the first four refuse or time out. 1.1.1.1:443 is provider egress, which the plan allows.

Docker daemon: `ps -eo args | grep dockerd` shows `/usr/bin/dockerd -H fd://`, so there is no TCP listener.
Inside the container, `stat /var/run/docker.sock` returns ENOENT.

## Claim 2: published port (local inspection only, no connects)

    docker port adv1-variant-a-1
    7400/tcp -> 100.71.226.67:7410

    ss -ltn | grep 7410
    LISTEN 0 4096 100.71.226.67:7410 0.0.0.0:*

Holds for the published port. Inside the container the server listens on 0.0.0.0:7400, and the
container's only address is `hostname -I` -> 172.18.0.2. The tailnet address does not exist inside
the container, so the plan's "binds to the tailnet only" cannot be met there.

## Claim 2/4: loopback reach to the server API (from inside the container)

    probe run as uid 10002: LOOPBACK 127.0.0.1:7400/health -> HTTP/1.1 200 OK body={"status":"ok"}
    probe run as uid 10004: LOOPBACK 127.0.0.1:7400/health -> HTTP/1.1 200 OK body={"status":"ok"}
    probe run as uid 10003: LOOPBACK 127.0.0.1:7400/health -> HTTP/1.1 200 OK body={"status":"ok"}
    probe run as uid 10001: LOOPBACK 127.0.0.1:7400/health -> HTTP/1.1 200 OK body={"status":"ok"}

## Claim 1 and claim 4: file and process probes (selected lines)

    probe run as 10002 (aphelion-agent)
    DENIED   read /etc/aphelion/policy.json (EACCES)
    DENIED   write /etc/aphelion/policy.json (EACCES)
    DENIED   append /var/lib/aphelion/audit.log (EACCES)
    DENIED   read /var/lib/aphelion-secrets/store.enc (EACCES)
    DENIED   read /run/secrets/bootstrap (EACCES)
    DENIED   write /etc/claude-code/managed-settings.json (EACCES)
    DENIED   write /usr/local/bin/x (EROFS)
    ALLOWED  read agent instructions alpha/instructions.md
    ALLOWED  write agent instructions alpha/instructions.md
    DENIED   read /proc/9/environ (/usr/local/bin/aphelion-stub server server) (EACCES)
    DENIED   read /proc/10/environ (/usr/local/bin/aphelion-stub broker broker) (EACCES)

    probe run as 10004 (aphelion-plugins)
    DENIED   list /etc/aphelion (EACCES)
    DENIED   read /var/lib/aphelion/store.db (EACCES)
    DENIED   read /var/lib/aphelion-secrets/store.enc (EACCES)
    DENIED   read /run/secrets/bootstrap (EACCES)
    DENIED   list /var/lib/aphelion-agents (EACCES)
    DENIED   read agent instructions alpha/instructions.md (EACCES)
    ALLOWED  write /var/lib/aphelion-plugins/own.txt

    probe run as 10003 (aphelion-secrets)
    ALLOWED  read /var/lib/aphelion-secrets/store.enc
    DENIED   read /run/secrets/bootstrap (EACCES)
    ALLOWED  read /proc/10/environ (/usr/local/bin/aphelion-stub broker broker)
    DENIED   list /var/lib/aphelion-agents (EACCES)

    probe run as 10001 (harness)
    ALLOWED  list /etc/aphelion, read/write /etc/aphelion/policy.json, read/write /var/lib/aphelion/store.db
    DENIED   list /var/lib/aphelion-secrets (EACCES)
    DENIED   read /run/secrets/bootstrap (EACCES)
    ALLOWED  read agent instructions alpha/instructions.md
    DENIED   write agent instructions alpha/instructions.md (EACCES)

    Container identity (probe ran with CapEff/CapBnd 0x00000000000000c0 = SETUID + SETGID only).
    Note: the "write /tmp" line reads DENIED for uids 10001, 10003 and 10004 because uid 10002
    created /tmp/probe.txt first in the same run. That is an artifact of my probe, not a finding.

## Claim 1: confused deputy through an agent-made symlink

    (as 10002) rm -f alpha/instructions.md && ln -s /etc/aphelion/policy.json alpha/instructions.md
    (as 10002) ln -s /var/lib/aphelion/store.db alpha/workspace/db-link
    (as 10002) ln -s /run/secrets/bootstrap alpha/workspace/bootstrap-link

    (as 10001, harness) readagentfile /var/lib/aphelion-agents/alpha/instructions.md
    PLAIN READ /var/lib/aphelion-agents/alpha/instructions.md (27 bytes):
    {"rules":["deny secrets"]}
    NOFOLLOW OPEN /var/lib/aphelion-agents/alpha/instructions.md -> ELOOP

    (as 10001) readagentfile .../alpha/workspace/db-link
    PLAIN READ .../workspace/db-link (1 bytes):
    X
    NOFOLLOW OPEN .../workspace/db-link -> ELOOP

    (as 10001) readagentfile .../alpha/workspace/bootstrap-link
    PLAIN READ .../workspace/bootstrap-link -> EACCES
    NOFOLLOW OPEN .../workspace/bootstrap-link -> ELOOP

## Claim 6: broker isolation at the uid level

    (as 10002) ls -l /proc/9/fd -> cannot open directory '/proc/9/fd': Permission denied
    (as 10002) read /proc/9/environ and /proc/9/mem of the broker -> EACCES

## Claim 7 evidence: shared namespaces

    The agent (10002) read /proc/<pid>/cmdline for the server and the broker (the probe enumerates /proc
    and only reads environ/mem once cmdline succeeds), so process listings are shared across uids.

## Unix socket peer credentials (the mechanism 0016 and 0018 assume)

    bun 1.4.5, Bun.listen unix socket: own props and prototype matching /cred|peer|uid/i ->
      [ "getPeerCertificate", "getTLSPeerFinishedMessage" ]   (no peer-credential accessor)
    node v24.22.3, net.Socket.prototype matching /peer|cred/i -> [ '_getpeername' ]
    (The Node run of the full socket test threw an unhandled 'error' and was not re-run, so the Node
    result is from the prototype listing only.)
