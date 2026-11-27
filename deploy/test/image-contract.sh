#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
readonly project=aphelion-contract
readonly image=aphelion:contract
readonly service=aphelion
readonly fixtures=apps/server/src/plugins/updates/fixtures/aphelion-test-plugin
readonly test_plugin=aphelion-test-plugin
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

as_root_in_volume() {
  docker run --rm --entrypoint "" --network none -v "${project}_plugin-files:/opt/aphelion/plugins" "$image" "$@"
}

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" logs --no-color 2>&1 | tail -n 60 >&2 || true
  fi
  docker rm --force aphelion-contract-bots aphelion-contract-nocg >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  as_root rm -rf /scratch/secrets /scratch/backups >/dev/null 2>&1 || true
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
  [[ $(id aphelion-cgroups) == "uid=10005(aphelion-cgroups) gid=10005(aphelion-cgroups) groups=10005(aphelion-cgroups),10007(aphelion-runs)" ]]
  [[ $(id aphelion-runner) == "uid=10006(aphelion-runner) gid=10006(aphelion-runner) groups=10006(aphelion-runner),10007(aphelion-runs)" ]]
  [[ $(getent group aphelion-runs) == "aphelion-runs:x:10007:aphelion-cgroups,aphelion-runner" ]]
  [[ $(getent group aphelion-cgroups) == "aphelion-cgroups:x:10005:" ]]
  [[ $(stat -c "%U:%G %a" /usr/local/lib/aphelion/run-adapter) == "root:root 755" ]]
  [[ $(getent group harness) == "harness:x:10001:" ]]
  [[ $(awk -F: "\$4 == 10001" /etc/passwd | cut -d: -f1) == harness ]]
  if getent passwd ubuntu || command -v sudo; then exit 1; fi
  [[ $(awk -F: "\$3 == 0" /etc/passwd | cut -d: -f1) == root ]]
  [[ -z $(find / -xdev -type f -perm /6000) ]]
  for tool in aphelion aphelion-secrets bun git tini; do command -v "$tool"; done
  for tool in claude codex grok opencode; do if command -v "$tool"; then exit 1; fi; done
' >/dev/null || fail "the image's users, groups or tools are not as expected"
pass "six fixed users, a private harness group, a run-folder group for the supervisor and runner only, a root-owned adapter entry script, no sudo, no set-user-ID files, no AI tool"

as_root bash -euo pipefail -c '
  [[ $DISABLE_AUTOUPDATER == 1 ]]
  [[ $(cat /etc/codex/requirements.toml) == "check_for_update_on_startup = false" ]]
  [[ $(stat -c "%U:%G %a" /opt/aphelion/tools) == "harness:harness 755" ]]
  for tool in claude grok opencode; do
    [[ $(readlink /usr/local/bin/$tool) == /opt/aphelion/tools/$tool/current/$tool ]]
  done
  [[ $(readlink /usr/local/bin/codex) == /opt/aphelion/tools/codex/current/codex-$(uname -m)-unknown-linux-musl ]]
  adapters=/usr/local/lib/aphelion/adapters/claude
  [[ $(stat -c "%U:%G %a" "${adapters%/*}" "$adapters" | tr "\n" " ") == "root:root 755 root:root 755 " ]]
  [[ $(ls -A "$adapters" | tr "\n" " ") == "adapter.js aphelion-plugin.json " ]]
  for file in "$adapters"/*; do [[ $(stat -c "%U:%G %a" "$file") == "root:root 644" ]]; done
  [[ -z $(find / -xdev \( -name node_modules -o -name "claude-agent-sdk*" \) -print -quit) ]]
  [[ -z $(find / -xdev -path /opt/aphelion/tools -prune -o -name claude -type f -print -quit) ]]
' || fail "the image doesn't turn off auto-update, own the tools folder, link the four tool names, or carry the Claude adapter bundle without node_modules or another claude binary"
pass "the image turns off Claude and Codex auto-update, makes the tools folder harness's, and links each tool name to a path that doesn't exist yet"
adapter_out=$(docker run --rm --interactive --entrypoint "" --network none --user aphelion-bot \
  --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 --env ANTHROPIC_API_KEY=sk-ant-contract-fake "$image" \
  bash -c 'mkdir -p /tmp/work && { printf "%s\n" "$1" "$2"; sleep 3; printf "%s\n" "$3"; } |
    bun /usr/local/lib/aphelion/adapters/claude/adapter.js 2>&1' _ \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"api":"0.1.0","bot":{"id":"contract"},"folder":"/tmp/work","resume":null}}' \
  '{"jsonrpc":"2.0","id":2,"method":"turn.start","params":{"turn":"t1","text":"hello"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"shutdown"}') || fail "the Claude adapter bundle didn't run: $adapter_out"
grep -qF '"result":{"api":"0.1.0","provider":"claude"}' <<<"$adapter_out" || fail "the Claude adapter didn't answer initialize: $adapter_out"
grep -qF '"event":{"type":"error","code":"cli-not-found"}' <<<"$adapter_out" || fail "the Claude adapter didn't report a missing CLI: $adapter_out"
[[ $adapter_out != *sk-ant* ]] || fail "the Claude adapter printed the key from its environment"
pass "the image runs the bundled Claude adapter with no node_modules, ships no other claude binary, and reports the missing CLI without the key"

as_root bash -euo pipefail -c '
  settings=/etc/claude-code/managed-settings.json
  [[ $(stat -c "%U:%G %a" "${settings%/*}" "$settings" | tr "\n" " ") == "root:root 755 root:root 644 " ]]
  [[ $(ls -A "${settings%/*}") == managed-settings.json ]]
  bun -e "
    const { permissions } = await Bun.file(\"$settings\").json();
    if (permissions.disableBypassPermissionsMode !== \"disable\" || permissions.disableAutoMode !== \"disable\") process.exit(1);
  "
' || fail "Claude Code's managed settings aren't root-owned, or don't turn off bypassPermissions and auto mode"
docker run --rm --entrypoint "" --network none --user aphelion-bot "$image" bash -c '
  [[ -r /etc/claude-code/managed-settings.json && ! -w /etc/claude-code/managed-settings.json && ! -w /etc/claude-code ]]
' || fail "aphelion-bot can change Claude Code's managed settings, or can't read them"
pass "Claude Code's managed settings turn off bypassPermissions and auto mode, and aphelion-bot can read but not change them"

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
  ["readlink", "/proc/{botRunner}/fd/0", "EACCES"],
  ["read", "/proc/{server}/environ", "EACCES"],
  ["read", "/proc/{server}/mem", "EACCES"],
  ["signal", "{server}", "EPERM"],
  ["signal", "{broker}", "EPERM"],
  ["write", "/opt/aphelion/plugins/contract-probe", "EACCES"],
  ["write", "/usr/local/bin", "EROFS"],
  ["write", "/var/lib/aphelion-plugins/contract-probe", "ok"]
]
EOF
mkdir "$scratch/plugins/$test_plugin"
tar -xf "$fixtures/v1.0.0/aphelion-plugin.tar" -C "$scratch/plugins/$test_plugin"
chmod -R a+rX,go-w "$scratch/plugins"
as_root bash -c 'rm /scratch/secrets/bootstrap && aphelion-secrets --new-key >/scratch/secrets/bootstrap && chmod 0400 /scratch/secrets/bootstrap'
key=$(as_root cat /scratch/secrets/bootstrap)
[[ $key == AGE-SECRET-KEY-1* ]] || fail "aphelion-secrets --new-key printed no age identity"

check_key() {
  docker run --rm -i --pull never --log-driver none --network none --read-only --user aphelion-secrets \
    --entrypoint /usr/local/bin/aphelion-secrets "$image" --check-key
}
shaped=AGE-SECRET-KEY-1$(printf 'Q%.0s' {1..58})
[[ $shaped =~ ^AGE-SECRET-KEY-1[0-9A-Z]{58}$ ]] || fail "the test key doesn't have the shape the old check accepted"
accepted=$(printf '%s\n' "$key" | check_key 2>&1) || fail "--check-key refused the key --new-key printed"
[[ $accepted == "The bootstrap key is a valid age identity" ]] || fail "--check-key printed something else for a good key: $accepted"
status=0
refused=$(printf '%s\n' "$shaped" | check_key 2>&1) || status=$?
[[ $status == 1 && $refused == *"The bootstrap key is not a valid age identity"* && $refused != *"$shaped"* ]] ||
  fail "--check-key didn't refuse a key with a wrong checksum with a fixed message ($status, $refused)"
status=0
refused=$(check_key </dev/null 2>&1) || status=$?
[[ $status == 1 && $refused == *"missing from standard input"* ]] || fail "--check-key accepted an empty standard input ($status, $refused)"
pass "aphelion-secrets --check-key accepts the key --new-key printed, refuses a key that only has the right shape, and never prints a key"

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

"${compose[@]}" create --quiet-pull >/dev/null 2>&1
for plugin in contract-probe "$test_plugin"; do
  "${compose[@]}" cp "$scratch/plugins/$plugin" "$service:/opt/aphelion/plugins/$plugin" >/dev/null
done
[[ $(as_root_in_volume stat -c '%U:%G %a' /opt/aphelion/plugins) == "harness:harness 755" ]] ||
  fail "the plugin-files volume isn't owned by harness with mode 755"
pass "docker compose cp copies a plugin into the plugin-files volume, which harness owns"

for plugin in contract-probe "$test_plugin"; do
  install=("${compose[@]}" run --rm -T --user harness "$service" aphelion plugin install "/opt/aphelion/plugins/$plugin")
  approval=$("${install[@]}" | sed -n 's/.*--approve \([0-9a-f]\{64\}\)$/\1/p')
  [[ -n $approval ]] || fail "plugin install printed no approval for $plugin"
  "${install[@]}" --approve "$approval" >/dev/null
done
pass "plugin install records the probe plugin and version 1.0.0 of the test plugin"

since=0
wait_for_log() {
  local text=$1 tries
  for ((tries = 0; tries < 300; tries++)); do
    if "${compose[@]}" logs --no-color --since "$since" 2>&1 | grep -F "$text" >/dev/null; then return 0; fi
    sleep 0.1
  done
  fail "the log never showed: $text"
}

server_pid() {
  docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do [[ $(tr "\0" " " <$p/cmdline 2>/dev/null) == "/usr/local/bin/aphelion --headless "* ]] && echo ${p#/proc/}; done; true'
}

"${compose[@]}" up --detach --quiet-pull >/dev/null 2>&1
container=$("${compose[@]}" ps --quiet "$service")
wait_for_log '"msg":"server started"'
wait_for_log 'plugin probe'
wait_for_log "$test_plugin 1.0.0 started"
if "${compose[@]}" logs --no-color 2>&1 | grep -F 'plugin probe failed'; then
  fail "the plugin reached something it must not"
fi
pass "a plugin started at boot as aphelion-plugins and was refused everything outside its data folder"
[[ $(docker exec --user harness "$container" stat -c '%a %U' /var/lib/aphelion/plugin-control.sock) == "600 harness" ]] ||
  fail "the plugin control socket isn't private to harness"
reload=$(docker exec --user harness "$container" \
  timeout 3 aphelion plugin dev /opt/aphelion/plugins/contract-probe 2>&1 || true)
grep -qF "Plugin dev mode is off." <<<"$reload" ||
  fail "the server didn't refuse a reload without the dev override: $reload"
pass "the server opens a plugin control socket only harness can use, and refuses reloads without the dev override"

[[ $(docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}}' "$container") == 'true false ["ALL"] ["CAP_KILL","CAP_SETGID","CAP_SETUID"] ["no-new-privileges:true","writable-cgroups=true"] 1024' ]] ||
  fail "docker inspect shows different hardening: $(docker inspect --format '{{json .HostConfig}}' "$container")"
(($(docker inspect --format '{{.HostConfig.Memory}}' "$container") > 0)) || fail "no memory limit"
if docker inspect --format '{{json .Mounts}}' "$container" | grep docker.sock >/dev/null; then
  fail "the Docker socket is mounted"
fi
pass "read-only root, no-new-privileges, writable cgroups, only SETUID, SETGID and KILL, limits set, no Docker socket"

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
      *bot-runner.js*) role=bot_runner user=10006 ;;
      *cgroup-supervisor.js*) role=supervisor user=10005 ;;
      "/usr/local/bin/aphelion --headless"*) role=server user=10001 ;;
      "/usr/local/bin/bun --no-env-file /opt/aphelion/"*) role=plugin user=10004 ;;
      *) continue ;;
    esac
    pid_of[$role]=$pid
    status=$(cat "$proc/status" 2>/dev/null) || continue
    uids=$(awk "/^Uid:/ {print \$2, \$3, \$4, \$5}" <<<"$status")
    [[ $uids == "$user $user $user $user" ]] || { echo "$role runs as $uids"; exit 1; }
    [[ $(awk "/^NoNewPrivs:/ {print \$2}" <<<"$status") == 1 ]] || { echo "$role can gain privileges"; exit 1; }
    [[ $(awk "/^Seccomp:/ {print \$2}" <<<"$status") == 2 ]] || { echo "$role has no seccomp filter"; exit 1; }
    caps=0000000000000000
    [[ $role != supervisor ]] || caps=00000000000000c0
    if ((user != 0)); then
      for set in CapInh CapPrm CapEff CapAmb; do
        [[ $(awk "/^$set:/ {print \$2}" <<<"$status") == "$caps" ]] || { echo "$role has $set other than $caps"; exit 1; }
      done
    fi
  done
  for role in init launcher broker runner supervisor bot_runner server plugin; do
    [[ -n ${pid_of[$role]:-} ]] || { echo "no $role process"; exit 1; }
  done
  [[ $(awk "/^Groups:/ {print \$2, \$3}" "/proc/${pid_of[server]}/status") == "10001 10002" ]] || { echo "the server lost its bot group"; exit 1; }
  [[ $(cat "/proc/${pid_of[bot_runner]}/cgroup") == "0::/bots/system/runner" ]] || { echo "the bot runner is not in its cgroup"; exit 1; }
  [[ $(cat "/proc/${pid_of[supervisor]}/cgroup") == "0::/bots/system/supervisor" ]] || { echo "the supervisor is not in its cgroup"; exit 1; }
  for role in init launcher broker runner server plugin; do
    [[ $(cat "/proc/${pid_of[$role]}/cgroup") == "0::/" ]] || { echo "the $role is inside the bots tree"; exit 1; }
  done
  cg=/sys/fs/cgroup/bots
  tree=$(stat -c "%U:%G %a" $cg $cg/cgroup.procs $cg/work $cg/system $cg/system/runner/cgroup.procs $cg/system/supervisor/cgroup.procs $cg/cgroup.subtree_control | tr "\n" " ")
  [[ $tree == "root:root 755 root:aphelion-cgroups 664 root:aphelion-cgroups 775 root:root 755 root:root 644 root:root 644 root:root 644 " ]] || { echo "the cgroup tree has other owners or modes: $tree"; exit 1; }
  [[ -z $(cat $cg/cgroup.subtree_control) ]] || { echo "the bots tree enables controllers"; exit 1; }
  [[ $(stat -c "%U:%G %a" /run/aphelion-runs) == "aphelion-cgroups:aphelion-runs 750" ]] || { echo "the run folder root has another owner or mode"; exit 1; }
  for fd in "/proc/${pid_of[broker]}"/fd/*; do
    [[ $(readlink "$fd") != /run/secrets/bootstrap ]] || { echo "the broker still holds the bootstrap file"; exit 1; }
  done
  ! compgen -G "/run/aphelion-launch.*" >/dev/null || { echo "the pipe folder is still there"; exit 1; }
  pipe() { stat -L -c %d:%i "/proc/$1/fd/$2"; }
  requests=$(pipe "${pid_of[server]}" 4)
  replies=$(pipe "${pid_of[server]}" 3)
  bot_requests=$(pipe "${pid_of[server]}" 6)
  bot_replies=$(pipe "${pid_of[server]}" 5)
  [[ $(pipe "${pid_of[runner]}" 0) == "$requests" && $(pipe "${pid_of[runner]}" 1) == "$replies" ]] || { echo "the server and plugin runner hold different pipes"; exit 1; }
  [[ $(pipe "${pid_of[bot_runner]}" 0) == "$bot_requests" && $(pipe "${pid_of[bot_runner]}" 1) == "$bot_replies" ]] || { echo "the server and bot runner hold different pipes"; exit 1; }
  sup_requests=$(pipe "${pid_of[bot_runner]}" 4)
  sup_replies=$(pipe "${pid_of[bot_runner]}" 3)
  [[ $(pipe "${pid_of[supervisor]}" 0) == "$sup_requests" && $(pipe "${pid_of[supervisor]}" 1) == "$sup_replies" ]] || { echo "the bot runner and supervisor hold different pipes"; exit 1; }
  for fd in /proc/[0-9]*/fd/*; do
    held=$(stat -L -c %d:%i "$fd" 2>/dev/null) || continue
    pid=${fd#/proc/}; pid=${pid%%/*}
    if [[ $held == "$requests" || $held == "$replies" ]]; then
      [[ $pid == "${pid_of[server]}" || $pid == "${pid_of[runner]}" ]] || { echo "process $pid ($(tr "\0" " " <"/proc/$pid/cmdline")) holds the plugin runner pipe through $fd"; exit 1; }
    fi
    if [[ $held == "$bot_requests" || $held == "$bot_replies" ]]; then
      [[ $pid == "${pid_of[server]}" || $pid == "${pid_of[bot_runner]}" ]] || { echo "process $pid ($(tr "\0" " " <"/proc/$pid/cmdline")) holds the bot runner pipe through $fd"; exit 1; }
    fi
    if [[ $held == "$sup_requests" || $held == "$sup_replies" ]]; then
      [[ $pid == "${pid_of[supervisor]}" || $pid == "${pid_of[bot_runner]}" ]] || { echo "process $pid holds the supervisor pipe"; exit 1; }
    fi
  done
' || fail "a process runs with the wrong user, privileges or pipes"
pass "each process runs as its own user with NoNewPrivs and seccomp, the supervisor with only SETUID and SETGID and every other one with no capabilities; the runner and supervisor sit in their own cgroups; only the two ends hold each private pipe"

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
  ["readlink", "/proc/{botRunner}/fd/0", "EACCES"],
  ["read", "/proc/{botRunner}/environ", "EACCES"],
  ["signal", "{botRunner}", "EPERM"],
  ["signal", "{supervisor}", "EPERM"],
  ["list", "/run/aphelion-runs", "EACCES"],
  ["write", "/sys/fs/cgroup/bots", "EACCES"],
  ["write", "/sys/fs/cgroup/bots/work", "EACCES"],
  ["signal", "{server}", "EPERM"],
  ["signal", "{runner}", "EPERM"],
  ["signal", "{broker}", "EPERM"],
  ["write", "/etc", "EROFS"],
  ["write", "/usr/local/bin", "EROFS"],
  ["write", "/opt/aphelion/plugins", "EACCES"]
]'
pass "aphelion-bot can't reach the config, state, secrets, plugins, broker, pipes, run folders, cgroup tree or other users' processes"

wait_for_log '"msg":"the cgroup check passed, so bots can start"'
wait_for_log "\"msg\":\"the bot runner started the bot's process\",\"bot\":\"chief-of-staff\""
wait_for_log "no adapter in this image runs the bot's provider, so the bot won't start\",\"bot\":\"triage\""
pass "the supervisor's start probe passed through the real start and kill path, and the server reaches the bot runner, which starts the bundled Claude adapter for the example bot"

bot_test=$scratch/bot-test
mkdir "$bot_test"
cp deploy/test/bot-runner/* "$bot_test/"
chmod 0755 "$bot_test/drive.mjs"
chmod 0644 "$bot_test/fake-adapter.mjs"
cat >"$scratch/bots.yaml" <<YAML
services:
  $service:
    volumes:
      - $bot_test/drive.mjs:/usr/local/bin/aphelion:ro
      - $bot_test/fake-adapter.mjs:/usr/local/lib/aphelion/adapters/claude/adapter.js:ro
YAML
bots=aphelion-contract-bots
"${compose[@]}" -f "$scratch/bots.yaml" run --detach --name "$bots" "$service" >/dev/null 2>&1 ||
  fail "the bot test container didn't start"
bot_log() { docker logs "$bots" 2>&1; }
bot_failure() {
  if bot_log | grep -q "^bot test FAIL"; then fail "$(bot_log | grep "^bot test FAIL")"; fi
}
await_bot_line() {
  local tries
  for ((tries = 0; tries < 900; tries++)); do
    if bot_log | grep -qx "$1"; then return 0; fi
    bot_failure
    sleep 0.2
  done
  fail "the bot test never printed \"$1\": $(bot_log | tail -n 20)"
}
bot_processes() {
  docker exec "$bots" bash -c 'for p in /proc/[0-9]*; do
    [[ $(awk "/^Uid:/ {print \$2}" "$p/status" 2>/dev/null) == 10002 ]] || continue
    echo "${p#/proc/} $(cut -d: -f3- "$p/cgroup" 2>/dev/null)"
  done; true'
}
check_checkpoint() {
  local name=$1 key values value listing leaves=""
  listing=$(bot_processes)
  while read -r key values; do
    for value in $values; do
      case $key in
        gone) ! grep -q "^$value " <<<"$listing" || fail "after $name, process $value of the bot is still alive: $listing" ;;
        alive) grep -q "^$value " <<<"$listing" || fail "after $name, process $value of the other bot is gone" ;;
        removed) docker exec "$bots" test ! -e "/sys/fs/cgroup$value" || fail "after $name, the cgroup $value is still there" ;;
        leaves) leaves+=" $value" ;;
      esac
    done
  done < <(docker exec "$bots" cat "/tmp/drive/$name")
  while read -r pid group; do
    [[ -n $pid ]] || continue
    [[ "$leaves " == *" $group "* ]] || fail "after $name, aphelion-bot process $pid runs in ${group:-no cgroup}, outside the live bots' cgroups"
  done <<<"$listing"
  docker exec --user harness "$bots" touch "/tmp/drive/$name.go"
}
for checkpoint in daemons cancelled stopped; do
  await_bot_line "checkpoint $checkpoint"
  check_checkpoint "$checkpoint"
done
await_bot_line "bot test passed"
bot_log | grep -E '^(isolation|folder|cancel|stop):'
docker rm --force "$bots" >/dev/null
pass "through the shipped launcher, supervisor and runner, a bot ran in a custom folder created on a fresh volume, a fake adapter's setsid and double-fork daemons and fork loop died on cancel and on stop (ps as root), the other bot kept its processes, and no bot could write the cgroup tree or signal the runner or supervisor"

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
  ["write", "/opt/aphelion/plugins", "ok"],
  ["list", "/var/lib/aphelion-bots", "ok"],
  ["write", "/var/lib/aphelion-bots", "EACCES"],
  ["connect", "/run/aphelion-secrets/broker.sock", "ok"],
  ["list", "/var/lib/aphelion-secrets", "EACCES"],
  ["list", "/var/lib/aphelion-plugins", "EACCES"],
  ["read", "/run/secrets/bootstrap", "EACCES"],
  ["readlink", "/proc/{runner}/fd/0", "EACCES"],
  ["readlink", "/proc/{botRunner}/fd/0", "EACCES"],
  ["list", "/run/aphelion-runs", "EACCES"],
  ["write", "/sys/fs/cgroup/bots/work", "EACCES"],
  ["signal", "{supervisor}", "EPERM"],
  ["signal", "{botRunner}", "EPERM"],
  ["signal", "{broker}", "EPERM"]
]'
pass "harness reads the config, state and bot folders, writes the plugin files and reaches the broker, and nothing else"

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

test_plugin_run() {
  docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do
    [[ $(tr "\0" " " <$p/cmdline 2>/dev/null) == "/usr/local/bin/bun --no-env-file "* ]] || continue
    folder=$(readlink $p/cwd 2>/dev/null) || continue
    [[ $folder == /opt/aphelion/plugins/'"$test_plugin"'* ]] && echo "${p#/proc/} $folder"
  done; true'
}

fake=$scratch/fake-github
mkdir -p "$fake/releases"
cp -r "$fixtures/v1.0.0" "$fixtures/v1.1.0" "$fake/releases/"
cp deploy/test/fake-github.mjs "$fake/"
echo v1.1.0 >"$fake/releases/latest"
chmod -R a+rX,go-w "$fake"
tar -C "$scratch" -cf - fake-github | docker exec -i --user harness "$container" tar -xf - -C /tmp
docker exec --detach --user harness --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$container" \
  bun /tmp/fake-github/fake-github.mjs /tmp/fake-github/releases 8099
update=(docker exec --user harness --env APHELION_GITHUB_API=http://127.0.0.1:8099 "$container" aphelion plugin update "$test_plugin")
for ((tries = 0; tries < 50; tries++)); do
  preview=$("${update[@]}" 2>&1) && break
  sleep 0.1
done
token=$(sed -n 's/.*--approve \([0-9a-f]\{64\}\)$/\1/p' <<<"$preview")
[[ -n $token ]] || fail "plugin update preview printed no approval value"
expected_preview=$(printf '%s\n' \
  "Plugin $test_plugin can update from 1.0.0 to 1.1.0." \
  "GitHub attests that jcore9-bot/$test_plugin's release workflow built 1.1.0 from tag v1.1.0." \
  $'adds\tevents\t"bot.status"' \
  "Review the changes above. To install 1.1.0 and grant its permissions, repeat the command with --approve $token")
[[ $preview == "$expected_preview" ]] || fail "plugin update printed a different preview"
server_before=$(server_pid)
[[ -n $server_before ]] || fail "no server process"
updated=$("${update[@]}" --approve "$token" 2>&1) || fail "plugin update --approve failed: $updated"
[[ $updated == "Updated $test_plugin from 1.0.0 to 1.1.0."$'\n'"$test_plugin 1.1.0 runs." ]] ||
  fail "plugin update printed something else: $updated"
wait_for_log "$test_plugin 1.1.0 started"
[[ $(server_pid) == "$server_before" ]] || fail "the server restarted during a plugin update"
[[ $(test_plugin_run) == *" /opt/aphelion/plugins/$test_plugin@1.1.0" ]] ||
  fail "the test plugin doesn't run from its 1.1.0 folder: $(test_plugin_run)"
pass "plugin update installs an attested release on approval and restarts only the plugin"

latest=$("${update[@]}" 2>&1) || fail "plugin update on the latest release failed: $latest"
[[ $latest == "$test_plugin is already on 1.1.0, the latest release. If the server still runs an older version, run aphelion plugin restart $test_plugin." ]] ||
  fail "plugin update didn't report that it was on the latest release: $latest"
restarted=$(docker exec --user harness "$container" aphelion plugin restart "$test_plugin" 2>&1) ||
  fail "plugin restart failed: $restarted"
[[ $restarted == "Restarted $test_plugin. It runs." ]] ||
  fail "plugin restart printed something else: $restarted"
[[ $(test_plugin_run) == *" /opt/aphelion/plugins/$test_plugin@1.1.0" ]] ||
  fail "plugin restart didn't start the approved version"
pass "plugin update reports the latest version and plugin restart starts it"

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
back=$(docker exec --user harness "$container" aphelion plugin rollback "$test_plugin" 2>&1) ||
  fail "plugin rollback failed: $back"
[[ $back == "Went back from $test_plugin 1.1.0 to 1.0.0."$'\n'"$test_plugin 1.0.0 runs." ]] ||
  fail "plugin rollback printed something else: $back"
wait_for_log "$test_plugin 1.0.0 started"
[[ $(server_pid) == "$server_before" ]] || fail "the server restarted during a rollback"
[[ $(test_plugin_run) == *" /opt/aphelion/plugins/$test_plugin" ]] ||
  fail "the test plugin doesn't run from its 1.0.0 folder: $(test_plugin_run)"
docker exec --user harness "$container" test ! -e "/opt/aphelion/plugins/$test_plugin@1.1.0" ||
  fail "rollback kept the 1.1.0 folder"
pass "plugin rollback goes back to 1.0.0 and deletes the 1.1.0 files"

docker exec --user harness --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$container" bun --eval '
  const fs = require("node:fs");
  const file = "/tmp/fake-github/releases/v1.1.0/aphelion-plugin.tar";
  const bytes = fs.readFileSync(file);
  bytes[1024] ^= 1;
  fs.writeFileSync(file, bytes);
'
running=$(test_plugin_run)
refused=$("${update[@]}" 2>&1) && fail "plugin update accepted an archive with a changed byte"
grep -qF "The release's attestation vouches for other bytes than the downloaded aphelion-plugin.tar, so Aphelion won't install it." <<<"$refused" ||
  fail "plugin update refused the changed archive for another reason: $refused"
[[ -n $running && $(test_plugin_run) == "$running" ]] ||
  fail "the running plugin stopped or restarted after a refused update"
docker exec --user harness "$container" bash -c 'for p in /proc/[0-9]*; do [[ ${p#/proc/} != "$$" && $(tr "\0" " " <$p/cmdline 2>/dev/null) == *fake-github.mjs* ]] && kill ${p#/proc/}; done; true'
pass "plugin update refuses an archive with one changed byte, and the running version keeps running"

fake_tools=$scratch/fake-tools
mkdir -p "$fake_tools"
printf '#!/bin/sh\necho fake tool ok\n' >"$fake_tools/claude-fake"
fake_sha=$(sha256sum "$fake_tools/claude-fake" | cut -d' ' -f1)
fake_size=$(stat -c %s "$fake_tools/claude-fake")
printf '#!/bin/sh\necho fake tool ok, second version\n' >"$fake_tools/claude-fake-2"
fake_sha_2=$(sha256sum "$fake_tools/claude-fake-2" | cut -d' ' -f1)
fake_size_2=$(stat -c %s "$fake_tools/claude-fake-2")
tool_list() {
  local sha=$1 size=$2 build version=${3:-9.9.9} file=${4:-claude-fake}
  build="{\"url\":\"http://127.0.0.1:8098/$file\",\"sha256\":\"$sha\",\"size\":$size,\"format\":\"binary\",\"entry\":\"claude\"}"
  printf '{"version":1,"tools":[{"name":"claude","version":"%s","builds":{"x86_64":%s,"aarch64":%s},"signIn":["claude","auth","login"],"status":["claude","auth","status"],"checksumSource":"recorded"}]}\n' "$version" "$build" "$build"
}
tool_list "$fake_sha" "$fake_size" >"$fake_tools/list-good.json"
tool_list "$(printf '0%.0s' {1..64})" "$fake_size" >"$fake_tools/list-wrong-checksum.json"
tool_list "$fake_sha" "$((fake_size - 1))" >"$fake_tools/list-too-large.json"
tool_list "$fake_sha_2" "$fake_size_2" 9.9.10 claude-fake-2 >"$fake_tools/list-next.json"
tool_list "$(printf '0%.0s' {1..64})" "$fake_size_2" 9.9.10 claude-fake-2 >"$fake_tools/list-next-wrong-checksum.json"
cp deploy/test/fake-tools.mjs "$fake_tools/"
chmod -R a+rX,go-w "$fake_tools"
tar -C "$scratch" -cf - fake-tools | docker exec -i --user harness "$container" tar -xf - -C /tmp
docker exec --detach --user harness --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$container" \
  bun /tmp/fake-tools/fake-tools.mjs /tmp/fake-tools 8098
tool_aphelion() {
  local list=$1
  shift
  docker exec --user harness --env "APHELION_TOOL_LIST=/tmp/fake-tools/$list" "$container" aphelion tool "$@"
}
as_bot() {
  docker exec --user aphelion-bot "$container" "$@"
}

shipped=$(docker exec --user harness "$container" aphelion tool list) || fail "tool list failed on the shipped list"
[[ $(sed -n 1p <<<"$shipped") == $'NAME\tVERSION\tINSTALLED\tSTATE\tSTATUS-COMMAND\tSIGN-IN-COMMAND' ]] || fail "tool list printed no header: $shipped"
grep -qP '^claude\t\S+\t-\tnot installed\tclaude auth status --text\tclaude auth login$' <<<"$shipped" || fail "tool list doesn't show Claude Code as not installed: $shipped"
grep -qP '^grok\t\S+\t-\tnot installed\t-\tgrok login --device-auth$' <<<"$shipped" || fail "tool list doesn't show Grok Build with no status command: $shipped"
[[ $(grep -c . <<<"$shipped") == 5 ]] || fail "tool list doesn't list the four tools: $shipped"
pass "tool list shows the four pinned tools as not installed, each with its status and sign-in command"

for _ in {1..50}; do
  docker exec --user harness --env BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 "$container" \
    bun --eval 'await fetch("http://127.0.0.1:8098/claude-fake")' >/dev/null 2>&1 && break
  sleep 0.1
done
for bad in list-wrong-checksum.json list-too-large.json; do
  status=0
  refused=$(tool_aphelion "$bad" install claude 2>&1) || status=$?
  [[ $status == 1 && $refused == *"the list"* ]] || fail "tool install didn't refuse $bad (exit $status): $refused"
  docker exec --user harness "$container" test ! -e /opt/aphelion/tools/claude ||
    fail "tool install left files behind after refusing $bad"
done
status=0
refused=$(tool_aphelion list-good.json install codex 2>&1) || status=$?
[[ $status == 1 && $refused == *"isn't on the list"* ]] || fail "tool install accepted a name that isn't on the list: $refused"
if as_bot sh -c 'command -v claude' >/dev/null 2>&1; then fail "Claude Code is on the PATH before it was installed"; fi
pass "tool install refuses a wrong checksum, a download over the listed size and a name that isn't on the list, and installs nothing"

installed=$(tool_aphelion list-good.json install claude 2>&1) || fail "tool install failed: $installed"
[[ $installed == "Installed claude 9.9.9."$'\n'"Sign in as aphelion-bot with: claude auth login" ]] ||
  fail "tool install printed something else: $installed"
[[ $(as_bot claude) == "fake tool ok" ]] || fail "aphelion-bot can't run the installed tool"
[[ $(as_bot sh -c 'command -v claude') == /usr/local/bin/claude ]] || fail "the installed tool isn't on aphelion-bot's PATH"
pass "tool install puts the tool where aphelion-bot runs it by its name"

inode=$(docker exec --user harness "$container" stat -c %i /opt/aphelion/tools/claude/9.9.9/claude)
again=$(tool_aphelion list-good.json install claude 2>&1) || fail "a second tool install failed: $again"
[[ $again == "claude 9.9.9 is already installed."* ]] || fail "a second tool install printed something else: $again"
[[ $(docker exec --user harness "$container" stat -c %i /opt/aphelion/tools/claude/9.9.9/claude) == "$inode" ]] ||
  fail "a second tool install replaced the files"
pass "installing the installed version again changes nothing"

for change in 'echo x >>/opt/aphelion/tools/claude/current/claude' \
  'touch /opt/aphelion/tools/claude/9.9.9/extra' \
  'ln -sfn / /opt/aphelion/tools/claude/current' \
  'rm /opt/aphelion/tools/claude/9.9.9/claude' \
  'mkdir /opt/aphelion/tools/other' \
  'chmod 0777 /opt/aphelion/tools/claude/9.9.9/claude'; do
  if as_bot bash -c "$change" >/dev/null 2>&1; then fail "aphelion-bot could change the tools volume with: $change"; fi
done
[[ $(as_bot claude) == "fake tool ok" ]] || fail "the tool stopped working after aphelion-bot's attempts"
pass "aphelion-bot can run the installed tool and can't write, replace, remove or re-mode anything in the tools volume"

listed=$(tool_aphelion list-next.json list 2>&1) || fail "tool list failed against the next list: $listed"
grep -qP '^claude\t9\.9\.10\t9\.9\.9\tupdate available\tclaude auth status\tclaude auth login$' <<<"$listed" ||
  fail "tool list doesn't say update available once the list names a newer version: $listed"
status=0
refused=$(tool_aphelion list-next-wrong-checksum.json update claude 2>&1) || status=$?
[[ $status == 1 && $refused == *"the list"* ]] || fail "tool update didn't refuse a wrong checksum (exit $status): $refused"
[[ $(as_bot claude) == "fake tool ok" ]] || fail "a refused tool update changed the installed tool"
updated=$(tool_aphelion list-next.json update claude 2>&1) || fail "tool update failed: $updated"
[[ $updated == "updated claude 9.9.9 -> 9.9.10" ]] || fail "tool update printed something else: $updated"
[[ $(as_bot claude) == "fake tool ok, second version" ]] || fail "aphelion-bot doesn't run the updated tool"
[[ $(docker exec --user harness "$container" ls /opt/aphelion/tools/claude | tr '\n' ' ') == "9.9.10 current " ]] ||
  fail "tool update left the old version folder behind"
inode=$(docker exec --user harness "$container" stat -c %i /opt/aphelion/tools/claude/9.9.10/claude)
for words in "update claude" "update"; do
  again=$(tool_aphelion list-next.json $words 2>&1) || fail "a second tool $words failed: $again"
  [[ $again == "claude is up to date (9.9.10)" ]] || fail "a second tool $words printed something else: $again"
done
[[ $(docker exec --user harness "$container" stat -c %i /opt/aphelion/tools/claude/9.9.10/claude) == "$inode" ]] ||
  fail "a second tool update replaced the files"
grep -qP '^claude\t9\.9\.10\t9\.9\.10\tinstalled\t' < <(tool_aphelion list-next.json list) ||
  fail "tool list doesn't show the updated tool as installed"
pass "tool list says update available, tool update installs the new version and removes the old one, and a second update changes nothing"

removed=$(tool_aphelion list-good.json remove claude 2>&1) || fail "tool remove failed: $removed"
[[ $removed == "Removed claude. Its sign-in in the bots volume is still there." ]] || fail "tool remove printed something else: $removed"
if as_bot sh -c 'command -v claude' >/dev/null 2>&1; then fail "Claude Code stayed on the PATH after tool remove"; fi
[[ $(tool_aphelion list-good.json remove claude 2>&1) == "claude isn't installed." ]] || fail "a second tool remove printed something else"
docker exec --user harness "$container" bash -c 'for p in /proc/[0-9]*; do [[ ${p#/proc/} != "$$" && $(tr "\0" " " <$p/cmdline 2>/dev/null) == *fake-tools.mjs* ]] && kill ${p#/proc/}; done; true'
pass "tool remove takes the tool off the PATH, and a second remove changes nothing"

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

host_deploy=$scratch/host-deploy
fakebin=$scratch/fakebin
mkdir "$host_deploy" "$fakebin"
printf 'APHELION_TAILNET_ADDRESS=%s\n' "$APHELION_TAILNET_ADDRESS" >"$host_deploy/.env"
touch "$scratch/credential"
cat >"$fakebin/systemctl" <<'FAKE'
#!/bin/bash
case $1 in
  is-enabled) echo enabled ;;
  is-active) echo active ;;
esac
FAKE
cat >"$fakebin/iptables" <<'FAKE'
#!/bin/bash
[[ ${FAKE_FIREWALL:-present} == present ]]
FAKE
cat >"$fakebin/curl" <<FAKE
#!/bin/bash
address=\$(docker inspect --format '{{(index .NetworkSettings.Networks "aphelion-contract").IPAddress}}' "\$FAKE_CONTAINER")
exec /usr/bin/curl "\${@//$APHELION_TAILNET_ADDRESS/\$address}"
FAKE
chmod +x "$fakebin"/*
host_root=()
if ((EUID != 0)); then
  if unshare --user --map-root-user true 2>/dev/null; then
    host_root=(unshare --user --map-root-user)
  else
    host_root=(sudo -n)
  fi
fi
host_aphelion() {
  "${host_root[@]}" env "PATH=$fakebin:$PATH" \
    "APHELION_DEPLOY=$host_deploy" "APHELION_CREDENTIAL=${APHELION_CREDENTIAL:-$scratch/credential}" \
    "FAKE_CONTAINER=$container" "FAKE_FIREWALL=${FAKE_FIREWALL:-}" \
    "COMPOSE_PROJECT_NAME=$project" "COMPOSE_FILE=$PWD/deploy/compose.yaml:$scratch/override.yaml" \
    deploy/host/aphelion "$@"
}

device_err=$scratch/device.err
token=$(host_aphelion device add contract-laptop --days 30 2>"$device_err") || fail "device add failed: $(cat "$device_err")"
[[ $token =~ ^[^[:space:]]+$ ]] || fail "device add printed more than the token on standard output: $token"
device_id=$(sed -n 's/^Added device "contract-laptop" with id \([0-9a-f]\{16\}\)\..*/\1/p' "$device_err")
[[ -n $device_id ]] || fail "device add printed no device id: $(cat "$device_err")"
listed=$(host_aphelion device list) || fail "device list failed"
grep -qP "^$device_id\tactive\t\S+\t\"contract-laptop\"$" <<<"$listed" || fail "device list doesn't show the new device: $listed"
revoked=$(host_aphelion device revoke "$device_id" 2>&1) || fail "device revoke failed: $revoked"
[[ $revoked == "Revoked device $device_id." ]] || fail "device revoke printed something else: $revoked"
grep -qP "^$device_id\trevoked\t" < <(host_aphelion device list) || fail "device list doesn't show the device as revoked"
status=0
refused=$(host_aphelion device revoke "$device_id" 2>&1) || status=$?
[[ $status == 1 && $refused == "No active device has the id $device_id."* ]] ||
  fail "revoking a revoked device didn't exit 1 with the server's message (exit $status): $refused"
pass "device add prints only the token on standard output, and device list and revoke pass the server's output and exit codes through"

http_status() {
  env "PATH=$fakebin:$PATH" "FAKE_CONTAINER=$container" curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' \
    --header "Authorization: Bearer $1" "http://$APHELION_TAILNET_ADDRESS:7400/api/status"
}
restore_token=$(host_aphelion device add contract-restore --days 30 2>/dev/null) ||
  fail "device add failed for the restore check"
[[ $(http_status "$restore_token") == 404 ]] || fail "the server refused a valid device token before the restore"

status=0
shown=$(host_aphelion status 2>&1) || status=$?
[[ $status == 0 && $shown == $'service: enabled, running\ncontainer: running\nhealth: ok\nAI tools: none installed' ]] ||
  fail "status printed something else (exit $status): $shown"
pass "status shows the running service, container and health, and no AI tool"

docker exec "$container" rm -f /tmp/runs-watch /tmp/runs-watch.stop
docker exec --detach --user aphelion-runner "$container" bash -c '
  until [[ -e /tmp/runs-watch.stop ]]; do
    for dir in /run/aphelion-runs/*; do
      probe=0
      for pid in $(cat "/sys/fs/cgroup/bots/work/${dir##*/}/cgroup.procs" 2>/dev/null); do
        [[ $(tr "\0" " " <"/proc/$pid/cmdline" 2>/dev/null) == *cgroup-probe.js* ]] && probe=1
      done
      ((probe == 1)) || continue
      for try in list open; do
        if [[ $try == list ]]; then out=$(ls "$dir" 2>&1 >/dev/null); else out=$( (exec 3<>"$dir/stdout") 2>&1); fi
        if [[ $? == 0 ]]; then echo "$try $dir ok"; elif [[ $out == *"Permission denied"* ]]; then echo "$try $dir denied"; fi
      done >>/tmp/runs-watch
    done
  done'
docker exec --user root "$container" /usr/local/lib/aphelion/launch --check-cgroups >/dev/null ||
  fail "the start check failed while a runs-group process watched the run folders"
docker exec --user root "$container" touch /tmp/runs-watch.stop
sleep 0.5
watched=$(docker exec "$container" cat /tmp/runs-watch 2>/dev/null || true)
grep -q "^list .* denied$" <<<"$watched" || fail "the runs-group watcher never saw the probe's run folder: $watched"
if grep " ok$" <<<"$watched"; then fail "a process in the aphelion-runs group reached the probe's run folder or pipes"; fi
pass "a process in the aphelion-runs group can't list the probe's run folder or open its pipes"

docker exec --user aphelion-bot "$container" touch /tmp/aphelion-probe
docker exec --user root "$container" /usr/local/lib/aphelion/launch --check-cgroups >/dev/null ||
  fail "the start check failed while an aphelion-bot file sat at /tmp/aphelion-probe"
leftover=$(docker exec "$container" find /tmp -maxdepth 1 -name 'aphelion-probe-*')
[[ -z $leftover ]] || fail "the start check left its folder behind: $leftover"
docker exec --user aphelion-bot "$container" rm -f /tmp/aphelion-probe
pass "a file an aphelion-bot process left at /tmp/aphelion-probe doesn't break the start check, and the probe's own folder is gone after it"

status=0
checked=$(host_aphelion check 2>&1) || status=$?
read -r passed total < <(sed -n 's/^\([0-9]*\) of \([0-9]*\) checks passed$/\1 \2/p' <<<"$checked")
[[ $status == 0 && -n $total && $passed == "$total" && $checked != *FAIL* ]] ||
  fail "check didn't pass every check (exit $status): $checked"
for name in "the service is enabled and running" "the container is running" "/health answers on the tailnet address" \
  "config check accepts the Compose file" "the container is hardened" "the bots' cgroups pass the start probe" \
  "the bootstrap credential exists" "the firewall chains exist"; do
  grep -qx "ok    $name" <<<"$checked" || fail "check didn't print ok for: $name"
done
pass "check passes every check against the running container"

status=0
checked=$(APHELION_CREDENTIAL=$scratch/no-such-file FAKE_FIREWALL=missing host_aphelion check 2>&1) || status=$?
[[ $status == 1 ]] || fail "check exited $status with a missing credential and no firewall chains"
grep -qx "FAIL  the bootstrap credential exists: $scratch/no-such-file is missing. Run host/install." <<<"$checked" ||
  fail "check didn't report the missing credential: $checked"
grep -qx "FAIL  the firewall chains exist: the APHELION-FORWARD chain is missing. Restart the service to install it." <<<"$checked" ||
  fail "check didn't report the missing firewall chains: $checked"
read -r passed total < <(sed -n 's/^\([0-9]*\) of \([0-9]*\) checks passed$/\1 \2/p' <<<"$checked")
[[ $checked == *"ok    the container is hardened"* && -n $total && $passed == $((total - 2)) ]] ||
  fail "check didn't still run the other checks and count two failures: $checked"
pass "check reports each failed check with its cause, keeps going, and exits 1"

started=$SECONDS
"${compose[@]}" stop >/dev/null 2>&1
[[ $(docker inspect --format '{{.State.ExitCode}}' "$container") == 0 ]] || fail "a clean stop exited non-zero"
((SECONDS - started < 40)) || fail "the clean stop took $((SECONDS - started)) seconds"
for text in "the launcher is stopping" '"msg":"server stopping"'; do
  "${compose[@]}" logs --no-color 2>&1 | grep -F "$text" >/dev/null || fail "the stop never logged: $text"
done
pass "docker compose stop stops every process and exits 0"

cat >"$scratch/no-cgroups.yaml" <<YAML
services:
  $service:
    security_opt: !override ["no-new-privileges:true"]
YAML
nocg=aphelion-contract-nocg
unsafe_line="\"msg\":\"bots can't start, because the cgroup check failed\",\"bot\":\"chief-of-staff\",\"check\":\"own-cgroup:"
"${compose[@]}" -f "$scratch/no-cgroups.yaml" run --detach --name "$nocg" "$service" >/dev/null 2>&1 ||
  fail "the container without writable cgroups didn't start"
for ((tries = 0; tries < 300; tries++)); do
  docker logs "$nocg" 2>&1 | grep -F "$unsafe_line" >/dev/null && break
  sleep 0.1
done
nocg_log=$(docker logs "$nocg" 2>&1)
docker rm --force "$nocg" >/dev/null
grep -F "$unsafe_line" <<<"$nocg_log" ||
  fail "without writable cgroups the server didn't log the fixed line: $(tail -n 20 <<<"$nocg_log")"
grep -F "the launcher couldn't build the bots' cgroup tree" <<<"$nocg_log" >/dev/null ||
  fail "without writable cgroups the launcher didn't say why"
if grep -F "the bot runner started the bot's process" <<<"$nocg_log"; then
  fail "a bot started without writable cgroups"
fi
pass "without writable-cgroups the launcher says why, the bot runner starts no bot, and the server logs one fixed line naming the failed check"

status=0
shown=$(host_aphelion status 2>&1) || status=$?
[[ $status == 1 && $shown == *"container: not running"* && $shown == *"health: no answer"* ]] ||
  fail "status didn't exit 1 with the container stopped (exit $status): $shown"
status=0
checked=$(host_aphelion check 2>&1) || status=$?
[[ $status == 1 ]] || fail "check exited $status with the container stopped"
for name in "the container is running" "/health answers on the tailnet address" "the container is hardened"; do
  grep -q "^FAIL  $name: " <<<"$checked" || fail "check didn't print FAIL for: $name"
done
pass "with the container stopped, status exits 1 and check fails the container, health and hardening checks"

restore_finish() {
  docker run --rm --pull never --network none --entrypoint "" --user harness \
    -v "${project}_state:/var/lib/aphelion" "$image" aphelion restore finish 2>&1
}
restored=$(restore_finish) || fail "restore finish failed: $restored"
for name in contract-probe "$test_plugin"; do
  grep -qF "aphelion plugin enable $name" <<<"$restored" || fail "restore finish didn't list $name: $restored"
done
again=$(restore_finish) ||
  fail "a second restore finish failed: $again"
[[ $again == "$restored" ]] || fail "a second restore finish printed something else: $again"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
"${compose[@]}" start >/dev/null 2>&1
wait_for_log '"msg":"plugin host started","installed":2'
wait_for_log 'a switched-off plugin was not started'
if "${compose[@]}" logs --no-color --since "$since" 2>&1 | grep -F "$test_plugin 1.0.0 started" >/dev/null; then
  fail "a switched-off plugin started"
fi
[[ $(http_status "$restore_token") == 401 ]] || fail "a device token from before the restore still works"
[[ $(host_aphelion device list | grep -c 'active') == 0 ]] || fail "device list still shows an active device after the restore"
fresh_token=$(host_aphelion device add contract-fresh --days 30 2>/dev/null) || fail "device add failed after the restore"
[[ $(http_status "$fresh_token") == 404 ]] || fail "a device enrolled after the restore was refused"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for name in contract-probe "$test_plugin"; do
  enable=(docker exec --user harness "$container" aphelion plugin enable "$name")
  approval=$("${enable[@]}" | sed -n 's/.*--approve \([0-9a-f]\{64\}\)$/\1/p')
  [[ -n $approval ]] || fail "plugin enable printed no approval for $name"
  switched=$("${enable[@]}" --approve "$approval" 2>&1) || fail "plugin enable failed for $name: $switched"
  [[ $switched == "Switched on $name. It runs." ]] || fail "plugin enable printed something else for $name: $switched"
done
wait_for_log "$test_plugin 1.0.0 started"
"${compose[@]}" stop >/dev/null 2>&1
pass "restore finish revokes every device token and switches every plugin off, and plugin enable switches each back on"

volume_files() {
  docker run --rm --pull never --network none --entrypoint "" -v "${project}_$1:/v:ro" "$image" \
    sh -c 'cd /v && find . -printf "%p %y %U:%G %m\n" | sort && find . -type f -exec sha256sum {} + | sort -k2'
}
snapshot() {
  local volume
  for volume in config bots secrets plugin-data plugin-files; do
    echo "== $volume"
    volume_files "$volume"
  done
}
before=$(snapshot)
[[ -n $before ]] || fail "the snapshot of the volumes is empty"
backups=$scratch/backups
made=$(host_aphelion backup --to "$backups") || fail "backup failed"
[[ $made == "$backups"/aphelion-backup-* && $("${host_root[@]}" readlink "$backups/latest") == "$(basename "$made")" ]] ||
  fail "backup printed something other than its folder: $made"
"${host_root[@]}" sh -c 'cd "$1" && sha256sum --check --status aphelion-data.tar.gz.sha256' sh "$made" || fail "the backup's checksum doesn't match"
"${compose[@]}" down --volumes >/dev/null 2>&1
[[ -z $(docker volume ls --quiet --filter "name=${project}_") ]] || fail "down --volumes left volumes behind"
status=0
refused=$(host_aphelion restore "$made/aphelion-data.tar.gz" 2>&1) || status=$?
[[ $status == 0 && $refused == *"Restore finished. Every device token is revoked."* && $refused == *"aphelion plugin enable $test_plugin"* ]] ||
  fail "restore didn't finish (exit $status): $refused"
[[ $(snapshot) == "$before" ]] || fail "the restored volumes differ from the ones that were backed up"
docker run --rm --pull never --network none --entrypoint "" -v "${project}_state:/v:ro" "$image" test -f /v/aphelion.db ||
  fail "the restored state volume has no database"
status=0
again=$(host_aphelion restore "$made" 2>&1) || status=$?
[[ $status == 1 && $again == *"already exist"* ]] || fail "restore ran over existing volumes (exit $status): $again"
"${compose[@]}" create --quiet-pull >/dev/null 2>&1
container=$("${compose[@]}" ps --all --quiet "$service")
pass "backup, then restore into new volumes, gives back every file with its owner and mode, and restore refuses over existing volumes"

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sleep 1
"${compose[@]}" start >/dev/null 2>&1
wait_for_log '"msg":"plugin host started","installed":2'
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
[[ $(docker exec --user harness "$container" stat -c '%a %U' /var/lib/aphelion/plugin-control.sock) == "600 harness" ]] ||
  fail "the plugin control socket isn't private to harness"
pass "with the dev override the server opens a plugin control socket only harness can use"

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

plugin_runs() {
  docker exec --privileged "$container" bash -c 'for p in /proc/[0-9]*; do [[ $(readlink $p/cwd 2>/dev/null) == /opt/aphelion/dev-plugin ]] && tr "\0" " " <$p/cmdline; echo; done' | grep -c "server.mjs" || true
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
[[ $(grep -cF "Reloaded dev-probe: the handshake finished." "$dev_out") -ge 2 ]] ||
  fail "plugin dev printed no reload replies: $(cat "$dev_out")"
if grep -qF "crashed after the handshake" "$dev_out"; then
  fail "plugin dev reported a crash for a reload: $(cat "$dev_out")"
fi
other=$("${dev_compose[@]}" exec -T --user harness "$service" \
  timeout 3 aphelion plugin dev /opt/aphelion/plugins/contract-probe 2>&1 || true)
grep -qF "Refused: dev mode reloads only /opt/aphelion/dev-plugin" <<<"$other" ||
  fail "plugin dev didn't refuse another folder: $other"
pass "plugin dev reloads the approved mounted plugin as aphelion-plugins after each edit, with the same server process"

sed -i 's/"version": "1.0.0"/"version": "1.0.1"/' "$dev/aphelion-plugin.json"
changed="Refused: dev-probe stays stopped: the plugin is dev-probe 1.0.1, but dev-probe 1.0.0 was approved"
for ((tries = 0; tries < 100; tries++)); do
  grep -qF "$changed" "$dev_out" && break
  sleep 0.1
done
grep -qF "$changed" "$dev_out" ||
  fail "plugin dev didn't refuse a changed manifest: $(cat "$dev_out")"
[[ $(plugin_runs) == 0 ]] || fail "the dev plugin still runs after its manifest changed"
approve_dev
touch_bundle 3 4
wait_for_log 'dev plugin build-4 started as uid 10004'
[[ $(server_pid) == "$first_server" ]] || fail "the server restarted during a plugin reload"
kill "$dev_client" 2>/dev/null || true
pass "a changed manifest leaves the dev plugin stopped until it is approved again"
