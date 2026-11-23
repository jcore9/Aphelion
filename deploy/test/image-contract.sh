#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
readonly project=aphelion-contract
readonly image=aphelion:contract
readonly service=aphelion
scratch=$(mktemp -d)
chmod 0755 "$scratch"

export APHELION_TAILNET_ADDRESS=${APHELION_TEST_TAILNET_ADDRESS:-100.64.0.1}
export APHELION_SUBNET=172.30.99.0/24

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "ok: $*"
}

as_root() {
  docker run --rm --entrypoint "" --network none -v "$scratch:/scratch" "$image" "$@"
}

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" logs --no-color 2>&1 | tail -n 60 >&2 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  as_root rm -rf /scratch/secrets >/dev/null 2>&1 || true
  rm -rf "$scratch"
}

if [[ -n ${APHELION_TEST_TAILNET_ADDRESS:-} ]]; then
  ports="ports: !override [\"$APHELION_TAILNET_ADDRESS:17400:7400\"]"
else
  ports="ports: !reset []"
fi
cat >"$scratch/override.yaml" <<EOF
services:
  $service:
    image: $image
    $ports
    volumes:
      - $scratch/plugins:/opt/aphelion/plugins:ro
    secrets: [bootstrap]
networks:
  aphelion:
    name: aphelion-contract
    driver_opts:
      com.docker.network.bridge.name: aphcontract0
secrets:
  bootstrap:
    file: $scratch/secrets/bootstrap
EOF
cat >"$scratch/everywhere.yaml" <<EOF
services:
  $service:
    ports: !override ["7400:7400"]
EOF
compose=(docker compose -p "$project" -f deploy/compose.yaml -f "$scratch/override.yaml")
trap cleanup EXIT
mkdir -p "$scratch/plugins/contract-probe" "$scratch/secrets"
touch "$scratch/secrets/bootstrap"

"${compose[@]}" build --quiet
pass "image builds"

as_root bash -euo pipefail -c '
  [[ $(id harness) == "uid=10001(harness) gid=10001(harness) groups=10001(harness),10002(aphelion-bot)" ]]
  [[ $(id aphelion-bot) == "uid=10002(aphelion-bot) gid=10002(aphelion-bot) groups=10002(aphelion-bot)" ]]
  [[ $(id aphelion-secrets) == "uid=10003(aphelion-secrets) gid=10003(aphelion-secrets) groups=10003(aphelion-secrets)" ]]
  [[ $(id aphelion-plugins) == "uid=10004(aphelion-plugins) gid=10004(aphelion-plugins) groups=10004(aphelion-plugins)" ]]
  [[ $(getent group harness) == "harness:x:10001:" ]]
  [[ $(awk -F: "\$4 == 10001" /etc/passwd | cut -d: -f1) == harness ]]
  if getent passwd ubuntu || command -v sudo; then exit 1; fi
  [[ $(awk -F: "\$3 == 0" /etc/passwd | cut -d: -f1) == root ]]
  [[ -z $(find / -xdev -type f -perm /6000) ]]
  for tool in aphelion aphelion-secrets bun git tini; do command -v "$tool"; done
  for tool in claude codex grok opencode; do if command -v "$tool"; then exit 1; fi; done
' >/dev/null || fail "the image's users, groups or tools are not as expected"
pass "four fixed users, a private harness group, no sudo, no set-user-ID files, no AI tool"

cp deploy/test/probe.mjs deploy/test/probe-plugin/* "$scratch/plugins/contract-probe/"
cat >"$scratch/plugins/contract-probe/checks.json" <<'EOF'
[
  ["list", "/etc/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"],
  ["list", "/var/lib/aphelion-bots", "EACCES"],
  ["connect", "/run/aphelion-secrets/broker.sock", "EACCES"],
  ["read", "/run/secrets/bootstrap", "EACCES"],
  ["readlink", "/proc/{server}/fd/3", "EACCES"],
  ["readlink", "/proc/{runner}/fd/0", "EACCES"],
  ["read", "/proc/{server}/environ", "EACCES"],
  ["read", "/proc/{server}/mem", "EACCES"],
  ["signal", "{server}", "EPERM"],
  ["signal", "{broker}", "EPERM"],
  ["write", "/opt/aphelion/plugins/contract-probe", "EROFS"],
  ["write", "/usr/local/bin", "EROFS"],
  ["write", "/var/lib/aphelion-plugins/contract-probe", "ok"]
]
EOF
chmod -R a+rX,go-w "$scratch/plugins"
as_root bash -c 'rm /scratch/secrets/bootstrap && aphelion-secrets --new-key >/scratch/secrets/bootstrap && chmod 0400 /scratch/secrets/bootstrap'
key=$(as_root cat /scratch/secrets/bootstrap)
[[ $key == AGE-SECRET-KEY-1* ]] || fail "aphelion-secrets --new-key printed no age identity"

"${compose[@]}" config | "${compose[@]}" run --rm -T --user harness "$service" \
  aphelion config check --compose - >/dev/null ||
  fail "config check refused the contract Compose file"
refused=$(docker compose -p "$project" -f deploy/compose.yaml -f "$scratch/override.yaml" \
  -f "$scratch/everywhere.yaml" config |
  "${compose[@]}" run --rm -T --user harness "$service" \
    aphelion config check --compose - 2>&1) && fail "config check accepted a port published on every address"
grep -qF "publishes the port on every host address" <<<"$refused" ||
  fail "config check failed for another reason: $refused"
pass "config check accepts the Compose file and refuses a port on every address"

install=("${compose[@]}" run --rm -T --user harness "$service" aphelion plugin install /opt/aphelion/plugins/contract-probe)
approval=$("${install[@]}" | sed -n 's/.*--approve \([0-9a-f]\{64\}\)$/\1/p')
[[ -n $approval ]] || fail "plugin install printed no approval"
"${install[@]}" --approve "$approval" >/dev/null
pass "plugin install records the probe plugin"

since=0
wait_for_log() {
  local text=$1 tries
  for ((tries = 0; tries < 300; tries++)); do
    if "${compose[@]}" logs --no-color --since "$since" 2>&1 | grep -F "$text" >/dev/null; then return 0; fi
    sleep 0.1
  done
  fail "the log never showed: $text"
}

"${compose[@]}" up --detach --quiet-pull >/dev/null 2>&1
container=$("${compose[@]}" ps --quiet "$service")
wait_for_log '"msg":"server started"'
wait_for_log 'plugin probe'
if "${compose[@]}" logs --no-color 2>&1 | grep -F 'plugin probe failed'; then
  fail "the plugin reached something it must not"
fi
pass "a plugin started at boot as aphelion-plugins and was refused everything outside its data folder"
docker exec --user harness "$container" test ! -e /var/lib/aphelion/plugin-dev.sock ||
  fail "the server opened a plugin dev socket without the dev override"
pass "without the dev override the server opens no plugin dev socket"

[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}' "$container") == 'true false ["ALL"] ["CAP_KILL","CAP_SETGID","CAP_SETUID"] ["no-new-privileges:true"] 1024' ]] ||
  fail "docker inspect shows different hardening: $(docker inspect --format '{{json .HostConfig}}' "$container")"
(($(docker inspect --format '{{.HostConfig.Memory}}' "$container") > 0)) || fail "no memory limit"
if docker inspect --format '{{json .Mounts}}' "$container" | grep docker.sock >/dev/null; then
  fail "the Docker socket is mounted"
fi
pass "read-only root, no-new-privileges, only SETUID, SETGID and KILL, limits set, no Docker socket"

docker exec --privileged "$container" bash -euo pipefail -c '
  declare -A pid_of
  for proc in /proc/[0-9]*; do
    pid=${proc#/proc/}
    [[ $pid == "$$" || $pid == "$BASHPID" ]] && continue
    command=$(tr "\0" " " <"$proc/cmdline" 2>/dev/null) || continue
    [[ -n $command ]] || continue
    case $command in
      "/usr/bin/tini "*) role=init user=0 ;;
      "/bin/bash /usr/local/lib/aphelion/launch"*) role=launcher user=0 ;;
      "/usr/local/bin/aphelion-secrets"*) role=broker user=10003 ;;
      *plugin-runner.js*) role=runner user=10004 ;;
      "/usr/local/bin/aphelion --headless"*) role=server user=10001 ;;
      "/usr/local/bin/bun --no-env-file "*) role=plugin user=10004 ;;
      *) continue ;;
    esac
    pid_of[$role]=$pid
    status=$(cat "$proc/status" 2>/dev/null) || continue
    uids=$(awk "/^Uid:/ {print \$2, \$3, \$4, \$5}" <<<"$status")
    [[ $uids == "$user $user $user $user" ]] || { echo "$role runs as $uids"; exit 1; }
    [[ $(awk "/^NoNewPrivs:/ {print \$2}" <<<"$status") == 1 ]] || { echo "$role can gain privileges"; exit 1; }
    [[ $(awk "/^Seccomp:/ {print \$2}" <<<"$status") == 2 ]] || { echo "$role has no seccomp filter"; exit 1; }
    if ((user != 0)); then
      for set in CapInh CapPrm CapEff CapAmb; do
        [[ $(awk "/^$set:/ {print \$2}" <<<"$status") == 0000000000000000 ]] || { echo "$role keeps $set"; exit 1; }
      done
    fi
  done
  for role in init launcher broker runner server plugin; do
    [[ -n ${pid_of[$role]:-} ]] || { echo "no $role process"; exit 1; }
  done
  [[ $(awk "/^Groups:/ {print \$2, \$3}" "/proc/${pid_of[server]}/status") == "10001 10002" ]] || { echo "the server lost its bot group"; exit 1; }
  for fd in "/proc/${pid_of[broker]}"/fd/*; do
    [[ $(readlink "$fd") != /run/secrets/bootstrap ]] || { echo "the broker still holds the bootstrap file"; exit 1; }
  done
  ! compgen -G "/run/aphelion-launch.*" >/dev/null || { echo "the pipe folder is still there"; exit 1; }
  pipe() { stat -L -c %i "/proc/$1/fd/$2"; }
  requests=$(pipe "${pid_of[server]}" 4)
  replies=$(pipe "${pid_of[server]}" 3)
  [[ $(pipe "${pid_of[runner]}" 0) == "$requests" && $(pipe "${pid_of[runner]}" 1) == "$replies" ]] || { echo "the server and runner hold different pipes"; exit 1; }
  for fd in /proc/[0-9]*/fd/*; do
    inode=$(stat -L -c %i "$fd" 2>/dev/null) || continue
    if [[ $inode == "$requests" || $inode == "$replies" ]]; then
      pid=${fd#/proc/}; pid=${pid%%/*}
      [[ $pid == "${pid_of[server]}" || $pid == "${pid_of[runner]}" ]] || { echo "process $pid holds the runner pipe"; exit 1; }
    fi
  done
' || fail "a process runs with the wrong user, privileges or pipes"
pass "each process runs as its own user with no capabilities, NoNewPrivs and seccomp; only the server and runner hold the pipe"

docker exec --user aphelion-secrets "$container" bash -euo pipefail -c '
  [[ $(stat -c %a /var/lib/aphelion-secrets/recipient.pub) == 600 ]]
  [[ ! -e /var/lib/aphelion-secrets/identity.agekey ]]
' || fail "the secrets volume holds a key file, or no recipient.pub"
pass "the secrets volume holds the store's public key and no private key"

probe() {
  local user=$1 checks=$2
  docker exec --user "$user" --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$container" \
    bun /opt/aphelion/plugins/contract-probe/probe.mjs "$checks" ||
    fail "$user reached something it must not, or was refused something it needs"
}

probe aphelion-bot '[
  ["list", "/etc/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"],
  ["list", "/var/lib/aphelion-plugins", "EACCES"],
  ["write", "/var/lib/aphelion-bots", "ok"],
  ["connect", "/run/aphelion-secrets/broker.sock", "EACCES"],
  ["read", "/run/secrets/bootstrap", "EACCES"],
  ["readlink", "/proc/{server}/fd/4", "EACCES"],
  ["readlink", "/proc/{runner}/fd/0", "EACCES"],
  ["signal", "{server}", "EPERM"],
  ["signal", "{runner}", "EPERM"],
  ["signal", "{broker}", "EPERM"],
  ["write", "/etc", "EROFS"],
  ["write", "/usr/local/bin", "EROFS"],
  ["write", "/opt/aphelion/plugins", "EROFS"]
]'
pass "aphelion-bot can't reach the config, state, secrets, plugins, broker, pipes or other processes"

probe aphelion-plugins '[
  ["list", "/etc/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"],
  ["list", "/var/lib/aphelion-bots", "EACCES"],
  ["connect", "/run/aphelion-secrets/broker.sock", "EACCES"],
  ["readlink", "/proc/{runner}/fd/0", "EACCES"],
  ["readlink", "/proc/{server}/fd/3", "EACCES"],
  ["signal", "{server}", "EPERM"]
]'
pass "aphelion-plugins can't reach the server's files, the broker, the bots or the runner's pipe"

probe harness '[
  ["list", "/etc/aphelion", "ok"],
  ["write", "/var/lib/aphelion", "ok"],
  ["list", "/var/lib/aphelion-bots", "ok"],
  ["write", "/var/lib/aphelion-bots", "EACCES"],
  ["connect", "/run/aphelion-secrets/broker.sock", "ok"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"],
  ["list", "/var/lib/aphelion-plugins", "EACCES"],
  ["read", "/run/secrets/bootstrap", "EACCES"],
  ["readlink", "/proc/{runner}/fd/0", "EACCES"],
  ["signal", "{broker}", "EPERM"]
]'
pass "harness reads the config, state and bot folders and reaches the broker, and nothing else"

probe aphelion-secrets '[
  ["list", "/etc/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion-bots", "EACCES"],
  ["read", "/run/secrets/bootstrap", "EACCES"]
]'
probe root '[
  ["read", "/run/secrets/bootstrap", "ok"],
  ["list", "/var/lib/aphelion", "EACCES"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"]
]'
pass "only root reads the bootstrap file, and root in the container can't read other users' folders"

if [[ -n ${APHELION_TEST_TAILNET_ADDRESS:-} ]]; then
  [[ $(curl --silent --max-time 5 "http://$APHELION_TAILNET_ADDRESS:17400/health") == '{"status":"ok"}' ]] ||
    fail "/health did not answer on the tailnet address"
  for address in 127.0.0.1 ${APHELION_TEST_LAN_ADDRESS:-}; do
    if curl --silent --max-time 5 "http://$address:17400/health" >/dev/null; then
      fail "/health answered on $address"
    fi
  done
  pass "the port answers on the tailnet address only"
fi

started=$SECONDS
"${compose[@]}" stop >/dev/null 2>&1
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container") == 0 ]] || fail "a clean stop exited non-zero"
((SECONDS - started < 40)) || fail "the clean stop took $((SECONDS - started)) seconds"
for text in "the launcher is stopping" '"msg":"server stopping"'; do
  "${compose[@]}" logs --no-color 2>&1 | grep -F "$text" >/dev/null || fail "the stop never logged: $text"
done
pass "docker compose stop stops every process and exits 0"

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
"${compose[@]}" start >/dev/null 2>&1
wait_for_log '"msg":"plugin host started","installed":1'
broker=$(docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do [[ $(tr "\0" " " <$p/cmdline 2>/dev/null) == /usr/local/bin/aphelion-secrets* ]] && echo ${p#/proc/}; done; true')
docker exec --privileged "$container" bash -c "kill -KILL $broker"
for ((tries = 0; tries < 100; tries++)); do
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == false ]] && break
  sleep 0.2
done
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container") == 1 ]] || fail "a dead broker didn't stop the container with status 1"
wait_for_log '"msg":"the secrets broker exited with status 137, so the container stops"'
pass "the plugin install survives a restart, and a dead broker stops the container with status 1"

as_root bash -c 'chmod 0444 /scratch/secrets/bootstrap'
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
"${compose[@]}" start >/dev/null 2>&1 || true
wait_for_log '/run/secrets/bootstrap must not be readable by group or others, so the container stops'
pass "the launcher refuses a bootstrap file that others can read"

missing=$(docker run --rm --network none --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --tmpfs /run:mode=0755 --tmpfs /run/aphelion-secrets:uid=10003,gid=10001,mode=2710 "$image" 2>&1) &&
  fail "the container started without the bootstrap file"
grep -qF '/run/secrets/bootstrap is missing. Start Aphelion with systemctl, which loads the bootstrap key, so the container stops' <<<"$missing" ||
  fail "the container stopped without the bootstrap file for another reason: $missing"
pass "the launcher refuses to start without the bootstrap file"

logs=$("${compose[@]}" logs --no-color 2>&1) || fail "docker compose logs failed: $logs"
[[ -n $logs ]] || fail "docker compose logs printed nothing"
if grep -F -- "$key" <<<"$logs" >/dev/null; then
  fail "the bootstrap key reached a container log"
fi
pass "the bootstrap key appears in no container log"

dev=$scratch/dev-plugin
mkdir -p "$dev"
cp deploy/test/dev-plugin/* "$dev/"
chmod -R a+rX,go-w "$dev"
export APHELION_PLUGIN_DEV_DIR=$dev
dev_compose=("${compose[@]}" -f deploy/compose.plugin-dev.yaml)
as_root chmod 0400 /scratch/secrets/bootstrap
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${dev_compose[@]}" up --detach --force-recreate >/dev/null 2>&1
container=$("${dev_compose[@]}" ps --quiet "$service")
wait_for_log '"msg":"plugin dev mode is on"'
[[ $(docker exec --user harness "$container" stat -c '%a %U' /var/lib/aphelion/plugin-dev.sock) == "600 harness" ]] ||
  fail "the plugin dev socket isn't private to harness"
pass "with the dev override the server opens a plugin dev socket only harness can use"

dev_install=("${dev_compose[@]}" exec -T --user harness "$service" aphelion plugin install /opt/aphelion/dev-plugin)
approve_dev() {
  local approval
  approval=$("${dev_install[@]}" | sed -n 's/.*--approve \([0-9a-f]\{64\}\)$/\1/p')
  [[ -n $approval ]] || fail "plugin install printed no approval for the dev plugin"
  "${dev_install[@]}" --approve "$approval" >/dev/null
}

dev_out=$scratch/plugin-dev.out
"${dev_compose[@]}" exec -T --user harness "$service" aphelion plugin dev /opt/aphelion/dev-plugin >"$dev_out" 2>&1 &
dev_client=$!
for ((tries = 0; tries < 100; tries++)); do
  grep -qF "Refused: /opt/aphelion/dev-plugin isn't approved" "$dev_out" && break
  sleep 0.1
done
grep -qF "Refused: /opt/aphelion/dev-plugin isn't approved" "$dev_out" ||
  fail "plugin dev reloaded a folder that isn't approved: $(cat "$dev_out")"
approve_dev

server_pid() {
  docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do [[ $(tr "\0" " " <$p/cmdline 2>/dev/null) == "/usr/local/bin/aphelion --headless "* ]] && echo ${p#/proc/}; done; true'
}
plugin_runs() {
  docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do tr "\0" " " <$p/cmdline 2>/dev/null; echo; done' | grep -c "server.mjs" || true
}
touch_bundle() {
  sed -i "s/build-$1/build-$2/" "$dev/server.mjs"
}

touch_bundle 1 2
wait_for_log 'dev plugin build-2 started as uid 10004'
first_server=$(server_pid)
[[ -n $first_server ]] || fail "no server process"
touch_bundle 2 3
wait_for_log 'dev plugin build-3 started as uid 10004'
[[ $(server_pid) == "$first_server" ]] || fail "the server restarted during a plugin reload"
[[ $(plugin_runs) == 1 ]] || fail "more than one copy of the dev plugin runs"
[[ $(grep -cF "Reloaded dev-probe: running" "$dev_out") -ge 2 ]] ||
  fail "plugin dev printed no reload replies: $(cat "$dev_out")"
other=$("${dev_compose[@]}" exec -T --user harness "$service" \
  timeout 3 aphelion plugin dev /opt/aphelion/plugins/contract-probe 2>&1 || true)
grep -qF "Refused: dev mode reloads only /opt/aphelion/dev-plugin" <<<"$other" ||
  fail "plugin dev didn't refuse another folder: $other"
pass "plugin dev reloads the approved mounted plugin as aphelion-plugins after each edit, with the same server process"

sed -i 's/"version": "1.0.0"/"version": "1.0.1"/' "$dev/aphelion-plugin.json"
for ((tries = 0; tries < 100; tries++)); do
  grep -qF "Refused: dev-probe stays stopped: the manifest changed since it was approved" "$dev_out" && break
  sleep 0.1
done
grep -qF "Refused: dev-probe stays stopped: the manifest changed since it was approved" "$dev_out" ||
  fail "plugin dev didn't refuse a changed manifest: $(cat "$dev_out")"
[[ $(plugin_runs) == 0 ]] || fail "the dev plugin still runs after its manifest changed"
approve_dev
touch_bundle 3 4
wait_for_log 'dev plugin build-4 started as uid 10004'
[[ $(server_pid) == "$first_server" ]] || fail "the server restarted during a plugin reload"
kill "$dev_client" 2>/dev/null || true
pass "a changed manifest leaves the dev plugin stopped until it is approved again"
