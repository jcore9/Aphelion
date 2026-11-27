#!/bin/bash
set -euo pipefail

if [[ ${1:-} != --inside ]]; then
  cd "$(dirname "$0")/../.."
  exec docker run --rm --privileged \
    --mount "type=bind,source=$PWD/deploy,target=/opt/aphelion/deploy,readonly" \
    ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db \
    bash /opt/aphelion/deploy/test/host-contract.sh --inside
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -qq --yes --no-install-recommends iproute2 iptables netcat-openbsd systemd >/dev/null

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  echo "ok: $*"
}

cat >/usr/bin/docker <<'EOF'
#!/bin/bash
echo "$*" >>/tmp/docker-calls
if [[ $* == *" config"* ]]; then echo "services: {}"; else cat >/dev/null; fi
EOF
chmod +x /usr/bin/docker
printf '[Service]\nExecStart=/usr/bin/docker\n' >/etc/systemd/system/docker.service
problems=$(systemd-analyze verify /opt/aphelion/deploy/host/aphelion.service 2>&1) ||
  fail "systemd-analyze refused aphelion.service: $problems"
[[ -z $problems ]] || fail "systemd-analyze found problems in aphelion.service: $problems"
pass "systemd-analyze accepts aphelion.service"

credential=$(sed -n 's/^LoadCredentialEncrypted=bootstrap://p' /opt/aphelion/deploy/host/aphelion.service)
grep -qx "readonly credential=$credential" /opt/aphelion/deploy/host/install ||
  fail "install creates the bootstrap key somewhere other than $credential"
grep -qF 'file: ${CREDENTIALS_DIRECTORY:-/run/credentials/aphelion.service}/bootstrap' /opt/aphelion/deploy/compose.yaml ||
  fail "compose.yaml doesn't read the bootstrap credential aphelion.service loads"
key=AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ
install -d -m 0700 "$(dirname "$credential")"
(umask 077 && printf '%s\n' "$key" | systemd-creds encrypt --name=bootstrap - "$credential" 2>/dev/null)
[[ $(stat -c %a "$credential") == 600 ]] || fail "the encrypted bootstrap key has mode $(stat -c %a "$credential")"
! grep -qF "$key" "$credential" || fail "the encrypted bootstrap key holds the key in plain text"
[[ $(systemd-creds decrypt --name=bootstrap "$credential" - 2>/dev/null) == "$key" ]] ||
  fail "the bootstrap key didn't decrypt under the name the unit loads"
pass "the unit, install and compose.yaml agree on the bootstrap credential, and it round-trips through systemd-creds"

namespace() {
  local name=$1 inside=$2 outside=$3 peer=$4 link=${5:-v-$1}
  ip netns add "$name"
  ip link add "$link" type veth peer name eth0 netns "$name"
  nsenter --net="/run/netns/$name" ip address add "$inside" dev eth0
  nsenter --net="/run/netns/$name" ip link set eth0 up
  nsenter --net="/run/netns/$name" ip link set lo up
  nsenter --net="/run/netns/$name" ip route add default via "$peer"
  if [[ -n $outside ]]; then
    ip address add "$outside" dev "$link"
  fi
  ip link set "$link" up
}

ip link add aphelion0 type bridge
ip address add 172.30.73.1/24 dev aphelion0
ip link set aphelion0 up
namespace bot 172.30.73.2/24 "" 172.30.73.1
ip link set v-bot master aphelion0
namespace lan 10.9.0.2/24 10.9.0.1/24 10.9.0.1
namespace peer 100.100.5.2/24 100.100.5.1/24 100.100.5.1 tailscale0
namespace internet 203.0.113.2/24 203.0.113.1/24 203.0.113.1
sysctl -q net.ipv4.ip_forward=1
iptables -t nat -A PREROUTING -d 100.100.5.1 -p tcp --dport 7400 -j DNAT --to-destination 172.30.73.2:7400

listen() {
  local where=$1 address=$2 port=$3
  if [[ $where == host ]]; then
    nc -lk -s "$address" -p "$port" >/dev/null 2>&1 &
  else
    nsenter --net="/run/netns/$where" nc -lk -s "$address" -p "$port" >/dev/null 2>&1 &
  fi
}
listen lan 10.9.0.2 80
listen host 10.9.0.1 22
listen host 100.100.5.1 22
listen peer 100.100.5.2 22
listen host 172.30.73.1 22
listen internet 203.0.113.2 443
listen bot 172.30.73.2 7400
sleep 0.5

connects() {
  nsenter --net="/run/netns/$1" nc -z -w 2 "$2" "$3" 2>/dev/null
}

expect() {
  local verdict=$1 from=$2 address=$3 port=$4
  if connects "$from" "$address" "$port"; then
    [[ $verdict == open ]] || fail "$from reached $address:$port"
  else
    [[ $verdict == closed ]] || fail "$from couldn't reach $address:$port"
  fi
}

targets=(10.9.0.2:80 10.9.0.1:22 100.100.5.1:22 100.100.5.2:22 172.30.73.1:22 203.0.113.2:443)
for target in "${targets[@]}"; do
  expect open bot "${target%:*}" "${target#*:}"
done
expect open peer 100.100.5.1 7400
expect open lan 100.100.5.1 7400
expect open lan 172.30.73.2 7400
pass "without the rules, the bot reaches all six targets, and the LAN reaches the published port"

iptables -I FORWARD 1 -j ACCEPT
iptables -I INPUT 1 -j ACCEPT
rules() { iptables -t mangle -S; ip6tables -t mangle -S; }
/opt/aphelion/deploy/host/firewall >/dev/null
first=$(rules)
/opt/aphelion/deploy/host/firewall >/dev/null
[[ $(rules) == "$first" ]] || fail "a second run changed the rules"
iptables -t mangle -E APHELION-FORWARD APHELION-FORWARD-N99999
iptables -t mangle -N APHELION-INPUT-N88888
iptables -t mangle -A APHELION-INPUT-N88888 -j RETURN
iptables -t mangle -N APHELION-FORWARD-NEXT
iptables -t mangle -I FORWARD 1 -j APHELION-FORWARD-NEXT
iptables -t mangle -I INPUT 1 -i aphelion0 -j APHELION-INPUT
/opt/aphelion/deploy/host/firewall >/dev/null
[[ $(rules) == "$first" ]] ||
  fail "a run after an interrupted one, or after older rules, left a different rule set"
pass "a second run changes nothing, and a run after an interrupted one or after older rules ends the same"

expect closed bot 10.9.0.2 80
expect closed bot 10.9.0.1 22
expect closed bot 100.100.5.1 22
expect closed bot 100.100.5.2 22
expect closed bot 172.30.73.1 22
expect open bot 203.0.113.2 443
pass "the bot reaches only the internet, even with accept-all rules first in the filter table, as Tailscale and ufw add"

expect open peer 100.100.5.1 7400
expect closed lan 100.100.5.1 7400
expect closed lan 172.30.73.2 7400
pass "only the tailnet interface opens connections to the published port, and the replies get back"

cd /opt/aphelion/deploy
if APHELION_TAILNET_ADDRESS=192.168.1.5 host/preflight >/dev/null 2>&1; then
  fail "preflight accepted an address outside the tailnet range"
fi
if APHELION_TAILNET_ADDRESS=100.100.9.9 APHELION_TAILNET_WAIT=1 host/preflight >/dev/null 2>&1; then
  fail "preflight went on without the tailnet address"
fi
ip address add 100.100.9.9/32 dev v-lan
if APHELION_TAILNET_ADDRESS=100.100.9.9 APHELION_TAILNET_WAIT=1 host/preflight >/dev/null 2>&1; then
  fail "preflight accepted a tailnet address on an interface other than tailscale0"
fi
rm -f /tmp/docker-calls
APHELION_TAILNET_ADDRESS=100.100.5.1 host/preflight >/dev/null
if ! grep -qx "compose --profile \* config" /tmp/docker-calls ||
  ! grep -qx "compose run --rm -T --user harness aphelion aphelion config check --compose -" /tmp/docker-calls; then
  fail "preflight didn't pipe the rendered Compose file into config check as harness"
fi
pass "preflight waits for the tailnet address on tailscale0, installs the firewall and runs config check"

export APHELION_TAILNET_ADDRESS=100.100.5.1
mkdir -p /etc/ufw
printf 'ENABLED=yes\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS=yes\n' >/etc/default/ufw
status=0
error=$(host/preflight 2>&1 >/dev/null) || status=$?
[[ $status == 1 && $error == *MANAGE_BUILTINS* ]] ||
  fail "preflight didn't exit with status 1 and name MANAGE_BUILTINS on stderr"
pass "preflight refuses enabled ufw with MANAGE_BUILTINS=yes and names the setting on stderr"

printf 'MANAGE_BUILTINS=no\n' >/etc/default/ufw
host/preflight >/dev/null || fail "preflight refused enabled ufw with MANAGE_BUILTINS=no"
pass "preflight accepts enabled ufw with MANAGE_BUILTINS=no"

printf 'ENABLED=no\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS=yes\n' >/etc/default/ufw
host/preflight >/dev/null || fail "preflight refused disabled ufw with MANAGE_BUILTINS=yes"
pass "preflight accepts disabled ufw with MANAGE_BUILTINS=yes"

rm -f /etc/ufw/ufw.conf /etc/default/ufw
host/preflight >/dev/null || fail "preflight refused missing ufw config files"
pass "preflight accepts missing ufw config files"

printf 'ENABLED="yes"\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS="yes"\n' >/etc/default/ufw
status=0
error=$(host/preflight 2>&1 >/dev/null) || status=$?
[[ $status == 1 && $error == *MANAGE_BUILTINS* ]] ||
  fail 'preflight accepted quoted "yes" or failed without naming MANAGE_BUILTINS'
pass 'preflight refuses enabled ufw with quoted "yes" values'

printf "MANAGE_BUILTINS='yes' # set by hand\n" >/etc/default/ufw
status=0
error=$(host/preflight 2>&1 >/dev/null) || status=$?
[[ $status == 1 && $error == *MANAGE_BUILTINS* ]] ||
  fail "preflight accepted a single-quoted yes with a trailing comment"
printf 'MANAGE_BUILTINS=yes\nMANAGE_BUILTINS=no\n' >/etc/default/ufw
host/preflight >/dev/null || fail "preflight refused a file whose last MANAGE_BUILTINS line is no"
printf 'MANAGE_BUILTINS=no\nMANAGE_BUILTINS=yes\n' >/etc/default/ufw
status=0
host/preflight >/dev/null 2>&1 || status=$?
[[ $status == 1 ]] || fail "preflight accepted a file whose last MANAGE_BUILTINS line is yes"
printf 'MANAGE_BUILTINS=yes\nMANAGE_BUILTINS=no true\n' >/etc/default/ufw
status=0
host/preflight >/dev/null 2>&1 || status=$?
[[ $status == 1 ]] || fail "preflight accepted MANAGE_BUILTINS=no as a one-command prefix, which leaves yes in sh"
printf 'ENABLED=YES\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS=yes\n' >/etc/default/ufw
status=0
host/preflight >/dev/null 2>&1 || status=$?
[[ $status == 1 ]] || fail "preflight accepted ENABLED=YES, which ufw treats as enabled"
printf 'ENABLED=yes\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS=yes\nexit 0\n' >/etc/default/ufw
status=0
host/preflight >/dev/null 2>&1 || status=$?
[[ $status == 1 ]] || fail "preflight went on when reading the ufw files stopped early"
pass "preflight reads the ufw files as sh does: quotes, comments, the last line, command prefixes and ENABLED=YES, and refuses when sh stops early"
rm -f /etc/ufw/ufw.conf /etc/default/ufw

make_deploy_root_owned() {
  local copy
  copy=$(mktemp -d)
  cp -a /opt/aphelion/deploy/. "$copy/"
  mount -t tmpfs tmpfs /opt/aphelion/deploy
  cp -a "$copy/." /opt/aphelion/deploy/
  chown -R root:root /opt/aphelion
  chmod -R go-w /opt/aphelion
  rm -rf "$copy"
}
cd /
make_deploy_root_owned
printf 'APHELION_TAILNET_ADDRESS=100.100.5.1\n' >/opt/aphelion/deploy/.env
fakebin=$(mktemp -d)
cat >"$fakebin/systemctl" <<'FAKE'
#!/bin/bash
echo "systemctl $*" >>"${FAKE_CALLS:-/dev/null}"
case $1 in
  is-enabled) echo enabled ;;
  is-active) echo "${FAKE_SERVICE:-active}"; [[ ${FAKE_SERVICE:-active} == active ]] ;;
  start)
    if [[ -n ${FAKE_DAMAGE_ARCHIVES:-} ]]; then
      echo damage >>"$(ls -d "$FAKE_DAMAGE_ARCHIVES"/aphelion-backup-*/ | tail -n 1)aphelion-data.tar.gz"
    fi ;;
esac
FAKE
cat >"$fakebin/curl" <<'FAKE'
#!/bin/bash
[[ ${FAKE_CONTAINER:-up} == up && ${*: -1} == http://100.100.5.1:7400/health ]] || exit 7
echo '{"status":"ok"}'
FAKE
cat >"$fakebin/docker" <<'FAKE'
#!/bin/bash
echo "docker $*" >>"${FAKE_CALLS:-/dev/null}"
case " $* " in
  *" ps "*)
    [[ ${FAKE_CONTAINER:-up} == up ]] && echo fake-container-id
    exit 0 ;;
  *" config --images "*)
    echo aphelion:test
    exit 0 ;;
  *" volume ls "*)
    for volume in ${FAKE_VOLUMES:-}; do echo "$volume"; done
    exit "${FAKE_VOLUME_LS_EXIT:-0}" ;;
  *" volume create "*)
    echo "${*: -1}"
    exit 0 ;;
  *" cp "*)
    exit "${FAKE_CP_EXIT:-0}" ;;
  *" --user harness aphelion aphelion device "*)
    echo "the-token"
    echo "Added device" >&2
    exit "${FAKE_DEVICE_EXIT:-0}" ;;
  *" --user harness aphelion aphelion tool list"*)
    declare -A version=([claude]=2.1.330 [codex]=0.172.0 [grok]=1.0.92 [opencode]=2.4.1)
    declare -A check=([claude]="claude auth status --text" [codex]="codex login status" [grok]=- [opencode]=-)
    declare -A signin=([claude]="claude auth login" [codex]="codex login --device-auth" [grok]="grok login --device-auth" [opencode]="opencode auth login")
    printf 'NAME\tVERSION\tINSTALLED\tSTATE\tSTATUS-COMMAND\tSIGN-IN-COMMAND\n'
    [[ -z ${FAKE_NO_SIGNIN:-} ]] || signin=([claude]="" [codex]="" [grok]="" [opencode]="")
    for name in claude codex grok opencode; do
      state="not installed" installed=-
      if [[ " ${FAKE_TOOLS:-} " == *" $name "* ]]; then
        state=installed installed=${version[$name]}
      elif [[ " ${FAKE_OLD_TOOLS:-} " == *" $name "* ]]; then
        state="update available" installed=0.1.0
      fi
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "${version[$name]}" "$installed" "$state" "${check[$name]}" "${signin[$name]}"
    done
    exit "${FAKE_TOOL_EXIT:-0}" ;;
  *" --user harness aphelion aphelion tool "*)
    all="$*"
    echo "ran tool ${all##* aphelion tool }"
    exit "${FAKE_TOOL_EXIT:-0}" ;;
  *" --user harness aphelion aphelion key "*)
    all="$*"
    case " $* " in
      *" key add "* | *" key replace "*) cat >"${FAKE_KEY_INPUT:-/dev/null}" ;;
    esac
    echo "ran key ${all##* aphelion key }"
    exit "${FAKE_KEY_EXIT:-0}" ;;
  *" --user harness aphelion aphelion plugin "*)
    all="$*"
    echo "ran plugin ${all##* aphelion plugin }"
    exit "${FAKE_PLUGIN_EXIT:-0}" ;;
  *" --user harness aphelion test -e "*)
    last=${*: -1}
    [[ " ${FAKE_PLUGINS:-} " == *" ${last##*/} "* ]]
    exit ;;
  *" --user harness aphelion test -L "*)
    exit 1 ;;
  *" --user aphelion-bot aphelion "*" auth login "* | *" --user aphelion-bot aphelion "*" login --device-auth "*)
    echo "SECRET-FROM-THE-TOOL"
    exit "${FAKE_SIGN_IN_EXIT:-0}" ;;
  *" --user aphelion-bot aphelion "*)
    all="$*"
    rest=${all#*--user aphelion-bot aphelion }
    echo "SECRET-FROM-THE-TOOL"
    [[ " ${FAKE_SIGNED_IN:-} " == *" ${rest%% *} "* ]]
    exit ;;
  *" compose version "*)
    [[ -e ${FAKE_STATE:-/nonexistent}/docker ]]
    exit ;;
  *" pull "*)
    [[ ${FAKE_PULL:-ok} == ok ]] || exit 1
    echo "${FAKE_PULLED:-${*: -1}}" >"$FAKE_STATE/pulled"
    exit 0 ;;
  *" image inspect "*)
    if [[ ${*: -1} == aphelion:local ]]; then cat "$FAKE_STATE/local"; else cat "$FAKE_STATE/pulled"; fi
    exit ;;
  *" tag "*)
    cp "$FAKE_STATE/pulled" "$FAKE_STATE/local"
    exit 0 ;;
  *" --project-directory "*" build "*)
    : >"$FAKE_STATE/local"
    exit 0 ;;
  *" --check-key "*)
    cat >/dev/null
    [[ ${FAKE_CHECK_KEY:-accept} == accept ]]
    exit ;;
  *" --new-key "*)
    echo "${FAKE_NEW_KEY:-AGE-SECRET-KEY-1FAKE}"
    exit 0 ;;
  *" compose "*" run "*)
    [[ -z ${FAKE_NEED_CREDENTIALS:-} || -d /run/credentials/aphelion.service ]] || exit 1
    exit 0 ;;
  *" run "*)
    mount=""
    for argument in "$@"; do
      case $argument in
        *:/backup | *:/backup:ro) mount=${argument%%:/backup*} ;;
      esac
    done
    case " $* " in
      *" tar --create "*)
        [[ -z ${FAKE_PACK_FAIL:-} ]] || exit 1
        echo "an archive of the volumes" | gzip >"$mount/aphelion-data.tar.gz" ;;
      *" tar --extract "*)
        exit "${FAKE_UNPACK_EXIT:-0}" ;;
      *" aphelion restore finish "* | *" aphelion restore finish")
        printf 'Restore finished. Every device token is revoked.\nEnroll a device: aphelion device add NAME\n'
        exit "${FAKE_FINISH_EXIT:-0}" ;;
    esac
    exit 0 ;;
esac
FAKE
chmod +x "$fakebin"/*
as_root_aphelion() { PATH=$fakebin:$PATH /opt/aphelion/deploy/host/aphelion "$@"; }

(umask 077 && printf '%s\n' "${key}Q" | systemd-creds encrypt --name=bootstrap - "$credential" 2>/dev/null)
link=/usr/local/bin/aphelion
export PATH=$fakebin:$PATH
/opt/aphelion/deploy/host/install >/dev/null || fail "install failed with a host that has a bootstrap key"
[[ $(readlink "$link") == /opt/aphelion/deploy/host/aphelion ]] || fail "install didn't link $link to the host command"
before=$(stat -c '%i %Z' "$link")
/opt/aphelion/deploy/host/install >/dev/null || fail "a second install failed"
[[ $(stat -c '%i %Z' "$link") == "$before" ]] || fail "a second install changed the link"
rm "$link"
printf '#!/bin/sh\n' >"$link"
if /opt/aphelion/deploy/host/install >/dev/null 2>&1; then fail "install replaced a file that isn't its link"; fi
[[ $(cat "$link") == '#!/bin/sh' ]] || fail "install changed a file that isn't its link"
rm "$link"
ln -s /nowhere "$link"
/opt/aphelion/deploy/host/install >/dev/null || fail "install failed over a link to another place"
[[ $(readlink "$link") == /opt/aphelion/deploy/host/aphelion ]] || fail "install left a link that points elsewhere"
chmod 0777 /opt/aphelion/deploy/host/aphelion
if /opt/aphelion/deploy/host/install >/dev/null 2>&1; then fail "install linked a host command that anyone can write"; fi
chmod 0755 /opt/aphelion/deploy/host/aphelion
pass "install links the host command into /usr/local/bin, changes nothing on a second run, keeps a file it doesn't own, and refuses a command others can write"

unit=/etc/systemd/system/aphelion.service
before=$(stat -c '%i %Z' "$unit")
/opt/aphelion/deploy/host/install >/dev/null || fail "install failed over an unchanged unit"
[[ $(stat -c '%i %Z' "$unit") == "$before" ]] || fail "a second install rewrote an unchanged unit"
status=0
error=$(FAKE_CHECK_KEY=reject /opt/aphelion/deploy/host/install 2>&1 >/dev/null) || status=$?
[[ $status == 1 && $error == *"holds no bootstrap key"* ]] ||
  fail "install kept a bootstrap key that the broker's parser rejects ($status, $error)"
[[ $(systemd-creds decrypt --name=bootstrap "$credential" - 2>/dev/null) == "${key}Q" ]] ||
  fail "install changed the bootstrap key it refused"
pass "install asks the broker's own parser about the bootstrap key, refuses one it rejects, and leaves an unchanged unit alone"

status=0
error=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$link" status 2>&1 >/dev/null) || status=$?
[[ $status == 2 && $error == "Run it with sudo, for example: sudo aphelion status" ]] ||
  fail "the command didn't refuse a user other than root with status 2: $status $error"
nonroot_key=sk-ant-fake-nonroot-canary-0123456789abcdef
status=0
error=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$link" key add claude "$nonroot_key" 2>&1 >/dev/null) || status=$?
[[ $status == 2 && $error == "Run it with sudo, for example: sudo aphelion status" ]] ||
  fail "the command repeated the words of a user other than root: $status $error"
! grep -qF "$nonroot_key" /tmp/docker-calls 2>/dev/null || fail "a user other than root got a key to docker"
help=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$link" --help) || fail "--help needs root"
[[ $help == *"aphelion status"* && $help == *"aphelion check"* && $help == *"aphelion device add NAME"* && $help == *"aphelion tool install NAME"* && $help == *"aphelion key add|replace NAME"* && $help == *"aphelion key test NAME"* && $help == *"aphelion key remove NAME"* ]] ||
  fail "--help doesn't list the commands: $help"
pass "the command refuses a user other than root with status 2 and a fixed line, and --help works for everyone"

for bad in "" bogus "status extra" device "device frobnicate" "check now" "device add" "device list extra" "device revoke" "device revoke a b" tool "tool frobnicate" "tool list extra" "tool install" "tool install a b" "tool remove" "tool remove a b" "tool update a b" "tool check a" "tool check now please" \
  key "key add" "key add a b" "key replace" "key test" "key test a b" "key remove" "key remove a b" "key frobnicate claude" \
  sign-in "sign-in a b" chat "chat a b" "backup extra" "backup --to" "backup --to a b" "restore a b" \
  plugin "plugin frobnicate" "plugin install" "plugin install a b" "plugin install a --approve" "plugin install a --other x" \
  "plugin update" "plugin update a --other x" "plugin enable a b" "plugin rollback" "plugin rollback a b" "plugin restart a b" "plugin dev" "plugin dev a b"; do
  status=0
  read -ra words <<<"$bad" || true
  error=$(as_root_aphelion "${words[@]}" 2>&1 >/dev/null) || status=$?
  [[ $status == 2 && $error == "usage:"* ]] ||
    fail "aphelion '$bad' didn't print usage and exit 2: $status $error"
done
pass "an unknown command or a wrong number of words prints the usage and exits 2"

export FAKE_TOOLS="claude codex grok" FAKE_SIGNED_IN=claude
status=0
out=$(as_root_aphelion status 2>&1) || status=$?
expected=$(printf '%s\n' \
  "service: enabled, running" \
  "container: running" \
  "health: ok" \
  "claude: signed in" \
  "codex: not signed in, or the check failed" \
  "grok: installed, sign-in state unknown")
[[ $status == 0 && $out == "$expected" ]] || fail "status printed something else (exit $status): $out"
[[ $out != *SECRET-FROM-THE-TOOL* ]] || fail "status printed the tool's own output"
pass "status lists each installed AI tool with its sign-in state and never prints the tool's output"

FAKE_TOOLS=codex FAKE_SIGNED_IN=codex
out=$(as_root_aphelion status) || fail "status failed with only codex installed"
[[ $out == *"codex: signed in"* && $out != *claude* && $out != *grok* ]] ||
  fail "status listed a tool that isn't installed: $out"
FAKE_TOOLS=""
out=$(as_root_aphelion status) || fail "status failed with no AI tool installed"
[[ $out == *"AI tools: none installed"* ]] || fail "status didn't say that no AI tool is installed: $out"
pass "status lists only the installed tools, or says none is installed"

out=$(FAKE_TOOLS=grok FAKE_OLD_TOOLS="claude opencode" FAKE_SIGNED_IN=claude as_root_aphelion status) || fail "status failed with tools to update"
[[ $out == *$'\nclaude: signed in (update available: 0.1.0 -> 2.1.330)'* ]] ||
  fail "status didn't show the update next to a signed-in tool: $out"
[[ $out == *$'\ngrok: installed, sign-in state unknown'$'\n'* || $out == *$'\ngrok: installed, sign-in state unknown' ]] ||
  fail "status added an update note to a tool that is current: $out"
[[ $out == *"opencode: installed, sign-in state unknown (update available: 0.1.0 -> 2.4.1)"* ]] ||
  fail "status didn't show the update next to a tool with no sign-in check: $out"
[[ $out != *codex* ]] || fail "status listed a tool that isn't installed: $out"
pass "status shows update available, with both versions, for a tool whose installed version differs from the list"

cp /opt/aphelion/deploy/.env /opt/aphelion/deploy/.env.saved
printf 'APHELION_TAILNET_ADDRESS="100.100.5.1" # the tailnet address\n' >/opt/aphelion/deploy/.env
out=$(as_root_aphelion status) || fail "status failed with a comment after the tailnet address in .env: $out"
[[ $out == *"health: ok"* ]] || fail "status didn't read the tailnet address past a comment in .env: $out"
mv /opt/aphelion/deploy/.env.saved /opt/aphelion/deploy/.env
pass "status reads the tailnet address from .env as Compose does, past quotes and a comment"

status=0
out=$(FAKE_CONTAINER=down as_root_aphelion status 2>&1) || status=$?
[[ $status == 1 && $out == *"container: not running"* && $out == *"health: no answer"* ]] ||
  fail "status didn't exit 1 with the container stopped (exit $status): $out"
status=0
out=$(FAKE_SERVICE=inactive as_root_aphelion status 2>&1) || status=$?
[[ $status == 1 && $out == *"service: enabled, not running (inactive)"* ]] ||
  fail "status didn't exit 1 with the service stopped (exit $status): $out"
pass "status exits 1 when the container or the service isn't running"

status=0
stdout=$(FAKE_DEVICE_EXIT=3 as_root_aphelion device add laptop --days 30 2>/dev/null) || status=$?
[[ $status == 3 && $stdout == the-token ]] || fail "device add changed the exit code or the standard output ($status, $stdout)"
stderr=$(as_root_aphelion device list 2>&1 >/dev/null)
[[ $stderr == "Added device" ]] || fail "device list changed the standard error: $stderr"
pass "device runs the server's command as harness and passes its output and exit code through"

out=$(as_root_aphelion tool install claude) || fail "tool install failed"
[[ $out == "ran tool install claude" ]] || fail "tool install didn't run the server's command: $out"
status=0
out=$(FAKE_TOOL_EXIT=4 as_root_aphelion tool remove claude 2>&1) || status=$?
[[ $status == 4 && $out == "ran tool remove claude" ]] || fail "tool remove changed the exit code or output ($status, $out)"
rows=$(FAKE_TOOLS=grok as_root_aphelion tool list) || fail "tool list failed"
grep -qP "^grok\t1\.0\.92\t1\.0\.92\tinstalled\t-\tgrok login --device-auth$" <<<"$rows" || fail "tool list didn't pass the server's table through: $rows"
pass "tool list, install and remove run the server's command as harness and pass its output and exit code through"

out=$(as_root_aphelion tool update) || fail "tool update with no name failed"
[[ $out == "ran tool update" ]] || fail "tool update with no name didn't run the server's command: $out"
out=$(as_root_aphelion tool update claude) || fail "tool update claude failed"
[[ $out == "ran tool update claude" ]] || fail "tool update claude didn't run the server's command: $out"
out=$(as_root_aphelion tool check) || fail "tool check failed"
[[ $out == "ran tool check" ]] || fail "tool check didn't run the server's command: $out"
status=0
out=$(FAKE_TOOL_EXIT=1 as_root_aphelion tool check 2>&1) || status=$?
[[ $status == 1 && $out == "ran tool check" ]] || fail "tool check changed the exit code or output ($status, $out)"
pass "tool update and tool check run the server's command as harness and pass its output and exit code through"

export FAKE_CALLS=/tmp/fake-calls
reset_calls() { : >"$FAKE_CALLS"; }
position() { grep -nF -- "$1" "$FAKE_CALLS" | head -n 1 | cut -d: -f1; }
called() { [[ -n $(position "$1") ]]; }
ordered() {
  local first second
  first=$(position "$1") second=$(position "$2")
  [[ -n $first && -n $second ]] && ((first < second))
}
exec_line="docker compose --project-directory /opt/aphelion/deploy exec"
with_terminal() {
  script --quiet --return --command "$(printf '%q ' env "PATH=$fakebin:$PATH" "$@")" /dev/null </dev/null | tr -d '\r'
}

export FAKE_TOOLS="claude codex grok opencode"
for entry in "claude auth login" "codex login --device-auth" "grok login --device-auth" "opencode auth login"; do
  reset_calls
  status=0
  out=$(with_terminal FAKE_SIGN_IN_EXIT=7 /opt/aphelion/deploy/host/aphelion sign-in "${entry%% *}") || status=$?
  [[ $status == 7 && $out == SECRET-FROM-THE-TOOL ]] ||
    fail "sign-in ${entry%% *} didn't pass the tool's output and exit code to the terminal ($status, $out)"
  grep -qxF "$exec_line --user aphelion-bot aphelion $entry" "$FAKE_CALLS" ||
    fail "sign-in ${entry%% *} didn't run '$entry' as aphelion-bot with a terminal: $(cat "$FAKE_CALLS")"
done
pass "sign-in runs each tool's own sign-in command as aphelion-bot on the owner's terminal, and passes its output and exit code through"

reset_calls
status=0
out=$(with_terminal /opt/aphelion/deploy/host/aphelion sign-in frobnicate 2>&1) || status=$?
[[ $status == 1 && $out == *"frobnicate isn't on the list of AI tools"* ]] || fail "sign-in accepted an unknown tool ($status, $out)"
status=0
out=$(FAKE_TOOLS="codex" with_terminal /opt/aphelion/deploy/host/aphelion sign-in claude 2>&1) || status=$?
[[ $status == 1 && $out == *"claude isn't installed. Install it first: sudo aphelion tool install claude"* ]] ||
  fail "sign-in accepted a tool that isn't installed ($status, $out)"
! called "aphelion-bot" || fail "sign-in ran a command in the container for a tool that can't sign in"
status=0
out=$(as_root_aphelion sign-in claude </dev/null 2>&1) || status=$?
[[ $status == 1 && $out == "aphelion: sign-in needs a terminal. Run it in a shell on the host, not through a pipe or a script." ]] ||
  fail "sign-in didn't refuse without a terminal ($status, $out)"
! called "aphelion-bot" || fail "sign-in ran the tool without a terminal"
status=0
out=$(FAKE_TOOLS=claude FAKE_NO_SIGNIN=1 with_terminal /opt/aphelion/deploy/host/aphelion sign-in claude 2>&1) || status=$?
[[ $status == 1 && $out == *"gave no sign-in command for claude"* ]] || fail "sign-in ran with an empty sign-in command ($status, $out)"
! called "aphelion-bot" || fail "sign-in ran compose exec with no command"
pass "sign-in refuses an unknown tool, a tool that isn't installed, a run without a terminal, and an empty sign-in command"

reset_calls
out=$(with_terminal /opt/aphelion/deploy/host/aphelion chat chief) || fail "chat failed with a terminal: $out"
called "docker run --rm -it --pull never --network host --entrypoint  --user harness --cap-drop ALL --security-opt no-new-privileges:true aphelion:test aphelion chat chief --url ws://100.100.5.1:7400/ws" ||
  fail "chat didn't run the client in a throwaway container on the host network: $(cat "$FAKE_CALLS")"
! called "compose exec" || fail "chat ran inside the service's container"
reset_calls
status=0
out=$(as_root_aphelion chat chief </dev/null 2>&1) || status=$?
[[ $status == 1 && $out == "aphelion: chat needs a terminal. Run it in a shell on the host, not through a pipe or a script." ]] ||
  fail "chat didn't refuse without a terminal ($status, $out)"
! called "docker run" || fail "chat started a container without a terminal"
status=0
out=$(with_terminal /opt/aphelion/deploy/host/aphelion chat Chief 2>&1) || status=$?
[[ $status == 1 && $out == "aphelion: that isn't a bot name. A bot name is lower case letters, digits and hyphens, like chief." ]] ||
  fail "chat accepted a name that isn't a bot name, or repeated it ($status, $out)"
! called "docker run" || fail "chat started a container for a name that isn't a bot name"
canary=aph_dev_0123456789abcdef_secret
status=0
out=$(with_terminal /opt/aphelion/deploy/host/aphelion chat "$canary" 2>&1) || status=$?
[[ $status == 1 && $out != *"$canary"* && $out != *aph_dev_* ]] || fail "chat repeated a bot name that looks like a token ($status, $out)"
! called "docker run" || fail "chat started a container for a token in place of a bot name"
cp /opt/aphelion/deploy/.env /opt/aphelion/deploy/.env.saved
: >/opt/aphelion/deploy/.env
status=0
out=$(with_terminal /opt/aphelion/deploy/host/aphelion chat chief 2>&1) || status=$?
mv /opt/aphelion/deploy/.env.saved /opt/aphelion/deploy/.env
[[ $status == 1 && $out == *"set APHELION_TAILNET_ADDRESS"* ]] || fail "chat went on without a tailnet address ($status, $out)"
! called "docker run" || fail "chat started a container without a tailnet address"
pass "chat runs the client in a throwaway container on the host network at the tailnet address, and refuses without a terminal, with a bad bot name, or without the address"

fake_key=sk-ant-fake-host-canary-0123456789abcdef
key_input=$(mktemp)
typed_in_terminal() {
  local typed=$1
  shift
  { sleep 2; printf '%s' "$typed"; } |
    script --quiet --return --command "$(printf '%q ' env "PATH=$fakebin:$PATH" "$@")" /dev/null | tr -d '\r'
}
for subcommand in add replace; do
  reset_calls
  : >"$key_input"
  status=0
  out=$(typed_in_terminal "$fake_key"$'\r' FAKE_KEY_INPUT="$key_input" FAKE_KEY_EXIT=3 /opt/aphelion/deploy/host/aphelion key "$subcommand" claude 2>&1) || status=$?
  [[ $status == 3 && $out == *"API key for claude: "* && $out == *"ran key $subcommand claude"* ]] ||
    fail "key $subcommand didn't prompt, run the server's command and pass its output and exit code through ($status, $out)"
  [[ $out != *"$fake_key"* ]] || fail "key $subcommand showed the key on the terminal"
  [[ $(cat "$key_input") == "$fake_key" ]] || fail "key $subcommand didn't send the typed key on standard input"
  grep -qxF "$exec_line -T --user harness aphelion aphelion key $subcommand claude" "$FAKE_CALLS" ||
    fail "key $subcommand didn't run the server's command as harness over exec -T: $(cat "$FAKE_CALLS")"
  ! grep -qF "$fake_key" "$FAKE_CALLS" || fail "key $subcommand put the key on a command line"
done
pass "key add and key replace read the key with the echo off and send it to the server's command on standard input, never on a command line"

: >"$key_input"
out=$(typed_in_terminal $'\t'"$fake_key "$'\r' FAKE_KEY_INPUT="$key_input" /opt/aphelion/deploy/host/aphelion key add claude 2>&1) ||
  fail "key add failed on a key with a tab and a space ($out)"
[[ $(cat "$key_input") == $'\t'"$fake_key " ]] ||
  fail "key add changed the typed line before it sent it, so the server can't refuse the tab or the space"
pass "key add sends the typed line as it is, with its spaces and tabs"

reset_calls
status=0
out=$(typed_in_terminal $'\004' /opt/aphelion/deploy/host/aphelion key add claude 2>&1) || status=$?
[[ $status == 1 && $out == *"aphelion: Stopped. No API key was read." ]] ||
  fail "key add didn't stop on Ctrl-D ($status, $out)"
! called "aphelion key" || fail "key add ran the server's command after Ctrl-D"
pass "key add stops on Ctrl-D without running the server's command"

for subcommand in add replace; do
  reset_calls
  status=0
  out=$(as_root_aphelion key "$subcommand" claude </dev/null 2>&1) || status=$?
  [[ $status == 1 && $out == "aphelion: key $subcommand needs a terminal, so you can type the key without it showing. Run it in a shell on the host, not through a pipe or a script." ]] ||
    fail "key $subcommand didn't refuse without a terminal ($status, $out)"
  ! called "aphelion key" || fail "key $subcommand ran the server's command without a terminal"
done
reset_calls
status=0
out=$(with_terminal /opt/aphelion/deploy/host/aphelion key add opencode 2>&1) || status=$?
[[ $status == 2 && $out == "aphelion: the tool name can't be opencode, which has no single API key. Sign it in with: sudo aphelion sign-in opencode" ]] ||
  fail "key add opencode didn't refuse on the host without a prompt ($status, $out)"
! called "aphelion key" || fail "key add opencode ran the server's command"
pass "key add and key replace refuse a run without a terminal, and key add refuses opencode before any prompt"

for subcommand in add replace test remove; do
  for words in "$fake_key" "claude $fake_key"; do
    reset_calls
    status=0
    read -ra extra <<<"$words"
    out=$(with_terminal /opt/aphelion/deploy/host/aphelion key "$subcommand" "${extra[@]}" 2>&1) || status=$?
    [[ $status == 2 && $out != *"$fake_key"* ]] ||
      fail "key $subcommand $words didn't refuse with status 2 without repeating the key ($status, $out)"
    [[ $words != "$fake_key" || $out == "aphelion: the tool name must be claude, codex or grok" ]] ||
      fail "key $subcommand with a key for a tool name printed something else: $out"
    ! called "$fake_key" || fail "key $subcommand $words put the key on a docker command line: $(cat "$FAKE_CALLS")"
    ! called "aphelion key" || fail "key $subcommand $words ran the server's command"
  done
done
pass "a key in place of the tool name, or after it, is refused on the host with a fixed line and never reaches docker"

for subcommand in test remove; do
  reset_calls
  status=0
  out=$(FAKE_KEY_EXIT=1 as_root_aphelion key "$subcommand" grok 2>&1) || status=$?
  [[ $status == 1 && $out == "ran key $subcommand grok" ]] ||
    fail "key $subcommand changed the exit code or output ($status, $out)"
  grep -qxF "$exec_line -T --user harness aphelion aphelion key $subcommand grok" "$FAKE_CALLS" ||
    fail "key $subcommand didn't run the server's command as harness: $(cat "$FAKE_CALLS")"
done
pass "key test and key remove run the server's command as harness and pass its output and exit code through"

bk=$(mktemp -d)/backups
export APHELION_BACKUP_DIR=$bk
unset FAKE_TOOLS
reset_calls
folder=$(as_root_aphelion backup) || fail "backup failed"
[[ $folder == "$bk"/aphelion-backup-????????-?????? && -d $folder ]] || fail "backup printed something other than the new folder: $folder"
[[ $(stat -c %a "$bk" "$folder") == $'700\n700' ]] || fail "the backup folders aren't private"
[[ $(readlink "$bk/latest") == "$(basename "$folder")" ]] || fail "latest doesn't point at the new folder"
(cd "$folder" && sha256sum --check --status aphelion-data.tar.gz.sha256) || fail "the new backup's checksum doesn't match"
[[ $(ls -A "$folder") == $'aphelion-data.tar.gz\naphelion-data.tar.gz.sha256' ]] || fail "the backup folder holds other files: $(ls -A "$folder")"
ordered "systemctl stop aphelion" "docker run" && ordered "docker run" "systemctl start aphelion" ||
  fail "backup didn't stop the service, pack, then start the service: $(cat "$FAKE_CALLS")"
pack=$(grep -F "tar --create" "$FAKE_CALLS")
for volume in config state bots secrets plugin-data plugin-files; do
  [[ $pack == *"-v aphelion_$volume:/data/$volume:ro "* ]] || fail "backup didn't mount aphelion_$volume read-only: $pack"
done
[[ $pack == "docker run --rm --pull never --network none --entrypoint  "* && $pack == *" -v $folder:/backup aphelion:test tar --create --gzip --numeric-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data ." ]] ||
  fail "backup packed with another command: $pack"
pass "backup stops the service, packs the six volumes read-only from the service's image into a new private folder, checks it, starts the service and prints the folder"

first=$folder
sleep 1
second=$(as_root_aphelion backup) || fail "a second backup failed"
[[ $second != "$first" && -d $first && $(readlink "$bk/latest") == "$(basename "$second")" ]] ||
  fail "the second backup didn't keep the first and move latest"
sleep 1
third=$(as_root_aphelion backup) || fail "a third backup failed"
[[ ! -e $first && -d $second && -d $third && $(readlink "$bk/latest") == "$(basename "$third")" ]] ||
  fail "the third backup didn't keep only the last two: $(ls "$bk")"
pass "each backup is a new folder, latest moves to it, and only the new folder and the one before it stay"

sleep 1
reset_calls
status=0
out=$(FAKE_PACK_FAIL=1 as_root_aphelion backup 2>&1) || status=$?
[[ $status == 1 && -d $second && -d $third && $(readlink "$bk/latest") == "$(basename "$third")" && $(ls "$bk" | wc -l) == 3 ]] ||
  fail "a failed pack changed the earlier backups or left a folder ($status): $(ls "$bk")"
called "systemctl start aphelion" || fail "a failed pack left the service stopped"
sleep 1
reset_calls
status=0
out=$(FAKE_DAMAGE_ARCHIVES=$bk as_root_aphelion backup 2>&1) || status=$?
[[ $status == 1 && $out == *"didn't pass its check"* ]] || fail "backup didn't fail when the archive changed after the checksum ($status, $out)"
[[ -d $second && -d $third && $(readlink "$bk/latest") == "$(basename "$third")" && $(ls "$bk" | wc -l) == 3 ]] ||
  fail "a backup that failed its check moved latest or removed the earlier copies: $(ls "$bk")"
called "systemctl start aphelion" || fail "a failed check left the service stopped"
pass "a backup that fails keeps both earlier copies and latest, removes its own folder and starts the service again"

reset_calls
elsewhere=$(mktemp -d)/elsewhere
out=$(FAKE_SERVICE=inactive as_root_aphelion backup --to "$elsewhere") || fail "backup --to failed"
[[ $out == "$elsewhere"/aphelion-backup-* && -f $out/aphelion-data.tar.gz && -L $elsewhere/latest ]] ||
  fail "backup --to didn't write into the folder it was given: $out"
! called "systemctl stop" && ! called "systemctl start" || fail "backup touched a service that wasn't running"
existing=$(mktemp -d)
chmod 1777 "$existing"
FAKE_SERVICE=inactive as_root_aphelion backup --to "$existing" >/dev/null || fail "backup --to an existing folder failed"
[[ $(stat -c %a "$existing") == 1777 ]] || fail "backup --to changed the mode of a folder that existed: $(stat -c %a "$existing")"
pass "backup --to writes into the given folder, keeps the mode of a folder that exists, and leaves a service that isn't running alone"

reset_calls
status=0
out=$(as_root_aphelion restore 2>&1) || status=$?
[[ $status == 0 ]] || fail "restore failed ($status): $out"
[[ $out == *"Restore finished. Every device token is revoked."* ]] || fail "restore didn't show what restore finish printed: $out"
ordered "systemctl stop aphelion" "volume ls" && ordered "volume ls" "volume create" && ordered "volume create" "tar --extract" &&
  ordered "tar --extract" "aphelion restore finish" && ordered "aphelion restore finish" "systemctl start aphelion" ||
  fail "restore ran its steps in another order: $(cat "$FAKE_CALLS")"
for volume in config state bots secrets plugin-data plugin-files; do
  grep -qF "volume create --label com.docker.compose.project=aphelion --label com.docker.compose.volume=$volume aphelion_$volume" "$FAKE_CALLS" ||
    fail "restore didn't create aphelion_$volume with the Compose labels"
done
extract=$(grep -F "tar --extract" "$FAKE_CALLS")
[[ $extract == *"-v $bk/$(basename "$third"):/backup:ro aphelion:test tar --extract --gzip --numeric-owner --same-owner --preserve-permissions --file /backup/aphelion-data.tar.gz --directory /data" && $extract == *"-v aphelion_state:/data/state "* ]] ||
  fail "restore unpacked with another command: $extract"
grep -qF "run --rm --pull never --network none --entrypoint  --user harness -v aphelion_state:/var/lib/aphelion aphelion:test aphelion restore finish" "$FAKE_CALLS" ||
  fail "restore didn't run restore finish as harness on the state volume: $(cat "$FAKE_CALLS")"
pass "restore stops the service, creates the six labelled volumes, unpacks the latest backup, runs restore finish as harness and starts the service"

reset_calls
out=$(COMPOSE_PROJECT_NAME=other as_root_aphelion restore "$second/aphelion-data.tar.gz" 2>&1) || fail "restore of an archive path failed: $out"
grep -qF "volume create --label com.docker.compose.project=other --label com.docker.compose.volume=state other_state" "$FAKE_CALLS" &&
  grep -qF -- "-v $second:/backup:ro" "$FAKE_CALLS" ||
  fail "restore didn't take the project name and the archive path it was given: $(cat "$FAKE_CALLS")"
reset_calls
as_root_aphelion restore "$second" >/dev/null 2>&1 || fail "restore of a folder path failed"
grep -qF -- "-v $second:/backup:ro" "$FAKE_CALLS" || fail "restore didn't use the folder it was given"
pass "restore takes a backup folder or an archive, and the project name from COMPOSE_PROJECT_NAME"

reset_calls
status=0
out=$(FAKE_VOLUMES="aphelion_state aphelion_other unrelated_state" as_root_aphelion restore 2>&1) || status=$?
[[ $status == 1 && $out == *"aphelion_state"* && $out != *"aphelion_other"* && $out == *"docker compose down"* && $out == *"docker volume rm aphelion_state"* ]] ||
  fail "restore didn't refuse over an existing volume and print the commands that remove it ($status, $out)"
! called "volume create" && ! called "tar --extract" && ! called "systemctl start" ||
  fail "restore went on over an existing volume: $(cat "$FAKE_CALLS")"
pass "restore refuses when a volume exists, prints the commands that remove it, and changes nothing"

damaged=$(mktemp -d)
cp -r "$third/." "$damaged/"
echo damage >>"$damaged/aphelion-data.tar.gz"
reset_calls
status=0
out=$(as_root_aphelion restore "$damaged" 2>&1) || status=$?
[[ $status == 1 && $out == *"checksum"* ]] || fail "restore accepted an archive that doesn't match its checksum ($status, $out)"
! called "systemctl" && ! called "volume" && ! called " run " || fail "restore touched the host after a bad checksum: $(cat "$FAKE_CALLS")"
rm "$damaged/aphelion-data.tar.gz.sha256"
status=0
out=$(as_root_aphelion restore "$damaged" 2>&1) || status=$?
[[ $status == 1 && $out == *"aphelion-data.tar.gz.sha256"* ]] || fail "restore accepted an archive with no checksum file ($status, $out)"
status=0
out=$(as_root_aphelion restore "$damaged/none" 2>&1) || status=$?
[[ $status == 1 ]] || fail "restore accepted a path that doesn't exist"
status=0
out=$(as_root_aphelion restore "$damaged/none" 2>&1) || status=$?
[[ $status == 1 && $out == *"doesn't exist"* ]] || fail "restore didn't say a missing path doesn't exist ($status, $out)"
mkdir "$damaged/swapped"
cp "$third/aphelion-data.tar.gz" "$damaged/swapped/"
echo "other" >"$damaged/swapped/other"
(cd "$damaged/swapped" && sha256sum other >aphelion-data.tar.gz.sha256)
reset_calls
status=0
out=$(as_root_aphelion restore "$damaged/swapped" 2>&1) || status=$?
[[ $status == 1 && $out == *"checksum"* ]] || fail "restore accepted a checksum file that names another file ($status, $out)"
! called "systemctl" && ! called "volume" || fail "restore touched the host after a checksum for another file"
mkdir "$damaged/-dash"
cp "$third/." "$damaged/-dash/" -r
reset_calls
as_root_aphelion restore "$damaged/-dash/aphelion-data.tar.gz" >/dev/null 2>&1 || fail "restore failed for a good archive in a folder with a leading dash"
reset_calls
status=0
out=$(FAKE_VOLUME_LS_EXIT=1 as_root_aphelion restore 2>&1) || status=$?
[[ $status == 1 && $out == *"docker volume ls failed"* ]] || fail "restore went on after docker volume ls failed ($status, $out)"
! called "volume create" && ! called "tar --extract" && ! called "systemctl start" || fail "restore changed things after docker volume ls failed"
pass "restore refuses an archive whose checksum is wrong, missing or for another file, a missing path, and a failed volume list, before it changes anything"

reset_calls
status=0
out=$(FAKE_FINISH_EXIT=1 as_root_aphelion restore 2>&1) || status=$?
[[ $status == 1 && $out == *"stays stopped"* ]] || fail "restore didn't say that the service stays stopped ($status, $out)"
! called "systemctl start" || fail "restore started the service after restore finish failed"
reset_calls
status=0
out=$(FAKE_UNPACK_EXIT=1 as_root_aphelion restore 2>&1) || status=$?
[[ $status == 1 && $out == *"docker volume rm aphelion_config aphelion_state aphelion_bots"* ]] || fail "restore didn't print how to start over after a failed unpack ($status, $out)"
! called "restore finish" && ! called "systemctl start" || fail "restore went on after a failed unpack"
reset_calls
FAKE_SERVICE=inactive as_root_aphelion restore >/dev/null 2>&1 || fail "restore failed with the service stopped"
! called "systemctl stop" && called "systemctl start aphelion" || fail "restore stopped a service that wasn't running, or didn't start it"
pass "restore leaves the service stopped when a step fails, and starts it only after restore finish exits 0"

for subcommand in update enable rollback restart; do
  reset_calls
  out=$(as_root_aphelion plugin "$subcommand" my-plugin) || fail "plugin $subcommand failed"
  [[ $out == "ran plugin $subcommand my-plugin" ]] || fail "plugin $subcommand printed something else: $out"
  grep -qxF "$exec_line -T --user harness aphelion aphelion plugin $subcommand my-plugin" "$FAKE_CALLS" ||
    fail "plugin $subcommand didn't run the server's command as harness: $(cat "$FAKE_CALLS")"
done
out=$(as_root_aphelion plugin update my-plugin --approve abc123) || fail "plugin update --approve failed"
[[ $out == "ran plugin update my-plugin --approve abc123" ]] || fail "plugin update --approve printed something else: $out"
status=0
out=$(FAKE_PLUGIN_EXIT=3 as_root_aphelion plugin rollback my-plugin 2>&1) || status=$?
[[ $status == 3 && $out == "ran plugin rollback my-plugin" ]] || fail "plugin rollback changed the exit code or output ($status, $out)"
reset_calls
as_root_aphelion plugin dev /opt/aphelion/dev-plugin >/dev/null || fail "plugin dev failed"
grep -qxF "$exec_line --user harness aphelion aphelion plugin dev /opt/aphelion/dev-plugin" "$FAKE_CALLS" ||
  fail "plugin dev didn't run without -T: $(cat "$FAKE_CALLS")"
pass "plugin update, enable, rollback, restart and dev run the server's command as harness and pass its output and exit code through"

source_folder=$(mktemp -d)/my-plugin
mkdir "$source_folder"
reset_calls
out=$(as_root_aphelion plugin install "$source_folder/") || fail "plugin install failed"
[[ $out == "ran plugin install /opt/aphelion/plugins/my-plugin" ]] || fail "plugin install printed something else: $out"
ordered "test -e /opt/aphelion/plugins/my-plugin" "cp $source_folder aphelion:/opt/aphelion/plugins/my-plugin" &&
  ordered "cp $source_folder" "plugin install /opt/aphelion/plugins/my-plugin" ||
  fail "plugin install didn't check, copy, then install: $(cat "$FAKE_CALLS")"
export FAKE_PLUGINS=my-plugin
reset_calls
status=0
out=$(as_root_aphelion plugin install "$source_folder" 2>&1) || status=$?
[[ $status == 1 && $out == *"my-plugin is already in the container"* ]] || fail "plugin install copied over a folder that exists ($status, $out)"
! called " cp " && ! called "plugin install" || fail "plugin install went on over a folder that exists"
reset_calls
out=$(as_root_aphelion plugin install "$source_folder" --approve abc123) || fail "plugin install --approve failed"
[[ $out == *"ran plugin install /opt/aphelion/plugins/my-plugin --approve abc123"* && $out == *"sudo systemctl restart aphelion"* ]] ||
  fail "plugin install --approve didn't pass through and name the next step: $out"
! called " cp " || fail "plugin install --approve copied the folder again"
status=0
out=$(FAKE_PLUGIN_EXIT=1 as_root_aphelion plugin install "$source_folder" --approve abc123 2>&1) || status=$?
[[ $status == 1 && $out != *"systemctl restart"* ]] || fail "plugin install named the next step after a failure ($status, $out)"
unset FAKE_PLUGINS
reset_calls
status=0
out=$(FAKE_CONTAINER=down as_root_aphelion plugin install "$source_folder" 2>&1) || status=$?
[[ $status == 1 && $out == *"isn't running"* ]] || fail "plugin install went on with the container stopped ($status, $out)"
! called " cp " && ! called "plugin install" || fail "plugin install copied into a stopped container"
pass "plugin install copies a host folder into the container, refuses a stopped container and a folder that is already there, and after --approve names the next step"

mkdir -p "$(dirname "$source_folder")/bad name" "$(dirname "$source_folder")/-flag" "$(dirname "$source_folder")/my-plugin@1.0.0"
touch "$(dirname "$source_folder")/a-file"
for bad in "bad name" -flag my-plugin@1.0.0 a-file missing; do
  reset_calls
  status=0
  out=$(as_root_aphelion plugin install "$(dirname "$source_folder")/$bad" 2>&1) || status=$?
  [[ $status == 1 && $out == "aphelion: "* ]] || fail "plugin install accepted '$bad' ($status, $out)"
  ! called " cp " && ! called "plugin install" || fail "plugin install went on with '$bad'"
done
ln -s "$source_folder" "$(dirname "$source_folder")/linked-plugin"
for bad in "my-plugin/.." "my-plugin/../my-plugin/.." ".." linked-plugin linked-plugin/; do
  reset_calls
  status=0
  case $bad in
    ..) out=$(cd "$(dirname "$source_folder")/my-plugin" && as_root_aphelion plugin install .. 2>&1) || status=$? ;;
    *) out=$(as_root_aphelion plugin install "$(dirname "$source_folder")/$bad" 2>&1) || status=$? ;;
  esac
  [[ $status == 1 && $out == "aphelion: "* ]] || fail "plugin install accepted '$bad' ($status, $out)"
  ! called " cp " && ! called "plugin install" || fail "plugin install went on with '$bad'"
done
pass "plugin install refuses a name that isn't a plain folder name, a symlink, a parent folder, a file, and a folder that doesn't exist"

installer_template=$(mktemp -d)
cp -a /opt/aphelion/deploy "$installer_template/deploy"
rm -f "$installer_template/deploy/.env"
export FAKE_STATE
FAKE_STATE=$(mktemp -d)
installbin=$(mktemp -d)
cat >"$installbin/uname" <<'FAKE'
#!/bin/bash
echo x86_64
FAKE
cat >"$installbin/tailscale" <<'FAKE'
#!/bin/bash
[[ ${FAKE_TAILSCALE:-up} == up ]] || exit 1
echo 100.100.5.1
FAKE
cat >"$installbin/apt-get" <<'FAKE'
#!/bin/bash
echo "apt-get $*" >>"$FAKE_CALLS"
[[ $* != *docker-ce* ]] || touch "$FAKE_STATE/docker"
FAKE
cat >"$installbin/git" <<'FAKE'
#!/bin/bash
echo "git $*" >>"$FAKE_CALLS"
args=" $* "
head_tag() { cat /opt/aphelion/.git/tag; }
case $args in
  *" clone "*)
    target=${*: -1}
    mkdir -p "$target"
    cp -a "$FAKE_TEMPLATE/deploy" "$target/deploy"
    mkdir "$target/.git"
    echo "${FAKE_CLONE_TAG:?}" >"$target/.git/tag" ;;
  *" remote get-url origin "*) echo "${FAKE_ORIGIN:-https://github.com/jcore9/Aphelion.git}" ;;
  *" symbolic-ref "*)
    [[ -e /opt/aphelion/.git/branch ]] && echo "refs/heads/$(cat /opt/aphelion/.git/branch)" || exit 1 ;;
  *" switch --quiet -- "*)
    target=${*: -1}
    [[ $target == "$(cat /opt/aphelion/.git/branchname 2>/dev/null)" ]] || exit 1
    echo "$target" >/opt/aphelion/.git/branch
    cp /opt/aphelion/.git/branchtip /opt/aphelion/.git/tag ;;
  *" describe "*) head_tag ;;
  *" status "*)
    [[ -z ${FAKE_STATUS_FAIL:-} ]] || { echo "fatal: not a git repository" >&2; exit 128; }
    cat /opt/aphelion/.git/dirty 2>/dev/null || true ;;
  *" fetch "*) touch "$FAKE_STATE/fetched" ;;
  *" rev-parse HEAD "*) echo "commit-of-$(head_tag)" ;;
  *" rev-parse "*)
    ref=${*: -1}
    ref=${ref#refs/tags/}
    ref=${ref%^\{commit\}}
    if [[ $ref == "$(head_tag)" || -e $FAKE_STATE/fetched ]]; then echo "commit-of-$ref"; else exit 128; fi ;;
  *" checkout "*)
    target=${*: -1}
    if [[ $target == "$(cat /opt/aphelion/.git/branchname 2>/dev/null)" ]]; then
      echo "$target" >/opt/aphelion/.git/branch
      cp /opt/aphelion/.git/branchtip /opt/aphelion/.git/tag
    else
      rm -f /opt/aphelion/.git/branch
      target=${target#tags/}
      echo "${target#commit-of-}" >/opt/aphelion/.git/tag
    fi ;;
esac
FAKE
cat >"$installbin/curl" <<'FAKE'
#!/bin/bash
echo "curl $*" >>"$FAKE_CALLS"
output=""
while (($#)); do
  [[ $1 != -o ]] || output=$2
  last=$1
  shift
done
case $last in
  */aphelion-image.sha256)
    [[ ${FAKE_DIGEST_FILE:-} == present ]] || exit 22
    printf '%s\n' "$FAKE_DIGEST_LINE" ;;
  https://download.docker.com/*) echo key >"$output" ;;
  *) exit 7 ;;
esac
FAKE
cat >"$installbin/systemctl" <<'FAKE'
#!/bin/bash
echo "systemctl $*" >>"$FAKE_CALLS"
case $1 in
  is-active) [[ -e $FAKE_STATE/active ]] ;;
  is-enabled) [[ -e $FAKE_STATE/enabled ]] ;;
  enable) [[ $* != *aphelion.service* ]] || touch "$FAKE_STATE/enabled" ;;
  show) [[ ! -e $FAKE_STATE/needreload ]] || echo yes ;;
  daemon-reload)
    if [[ -n ${FAKE_RELOAD_FAIL_ONCE:-} && ! -e $FAKE_STATE/reload-failed ]]; then
      touch "$FAKE_STATE/reload-failed" "$FAKE_STATE/needreload"
      exit 1
    fi
    rm -f "$FAKE_STATE/needreload" ;;
  start) touch "$FAKE_STATE/active" ;;
esac
FAKE
chmod +x "$installbin"/*
export FAKE_TEMPLATE=$installer_template
export FAKE_NEED_CREDENTIALS=1
export FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000001
export FAKE_CLONE_TAG=v9.9.9
export PATH=$installbin:$PATH
mount -t tmpfs tmpfs /opt

unit=/etc/systemd/system/aphelion.service
link=/usr/local/bin/aphelion
fresh_host() {
  rm -rf /opt/aphelion "$FAKE_STATE"
  mkdir "$FAKE_STATE"
  rm -f "$credential" "$unit" "$link"
  unset FAKE_PULL FAKE_PULLED FAKE_DIGEST_FILE FAKE_CHECK_KEY FAKE_TAILSCALE FAKE_ORIGIN FAKE_STATUS_FAIL FAKE_RELOAD_FAIL_ONCE
  rm -f /etc/ufw/ufw.conf /etc/default/ufw
  reset_calls
}
run_installer() {
  local status=0
  bash -s -- "$@" <"$installer_template/deploy/install.sh" >/tmp/installer-out 2>&1 || status=$?
  return "$status"
}
snapshot() {
  find /opt/aphelion "$unit" "$link" "$credential" -printf '%p %i %C@ %s\n' | sort
}

fresh_host
cpuinfo=$(mktemp)
grep -v sse4_2 /proc/cpuinfo | sed 's/^flags.*/flags : fpu/' >"$cpuinfo"
mount --bind "$cpuinfo" /proc/cpuinfo
status=0
run_installer --tag v9.9.9 || status=$?
umount /proc/cpuinfo
[[ $status == 1 ]] || fail "the installer went on without sse4_2 ($status)"
grep -q "sse4_2" /tmp/installer-out && grep -q "CPU type" /tmp/installer-out ||
  fail "the installer didn't explain the missing sse4_2: $(cat /tmp/installer-out)"
[[ ! -s $FAKE_CALLS && ! -e /opt/aphelion ]] || fail "the installer changed the host before it stopped for sse4_2: $(cat "$FAKE_CALLS")"
pass "the installer stops for a missing sse4_2 before it changes anything"

for bad in "" "--tag" "--tag main" "--tag v1;rm" "--frobnicate" "--tag v9.9.9 extra"; do
  fresh_host
  status=0
  # shellcheck disable=SC2086
  run_installer $bad || status=$?
  [[ $status == 2 && ! -s $FAKE_CALLS ]] || fail "the installer accepted '$bad' ($status)"
done
fresh_host
FAKE_TAILSCALE=down
export FAKE_TAILSCALE
status=0
run_installer --tag v9.9.9 || status=$?
unset FAKE_TAILSCALE
[[ $status == 1 && ! -e /opt/aphelion ]] && grep -q "Tailscale" /tmp/installer-out ||
  fail "the installer went on without a tailnet address ($status)"
pass "the installer refuses a missing or odd tag and a host without a tailnet address, and changes nothing"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install with --no-start failed: $(cat /tmp/installer-out)"
ordered "apt-get install" "git clone" && ordered "git clone" "docker pull" && ordered "docker pull" "--new-key" ||
  fail "the installer didn't install Docker, clone, download the image, then create the key: $(cat "$FAKE_CALLS")"
called " build" && fail "the installer built an image it could download"
called "docker tag $FAKE_DIGEST_LINE aphelion:local" || fail "the installer didn't tag the downloaded image as aphelion:local"
[[ $(cat /opt/aphelion/deploy/.env) == APHELION_TAILNET_ADDRESS=100.100.5.1 ]] || fail "the installer wrote another .env: $(cat /opt/aphelion/deploy/.env)"
[[ $(readlink "$link") == /opt/aphelion/deploy/host/aphelion && -f $unit && -f $credential ]] ||
  fail "the installer didn't run host/install"
called "systemctl start" && fail "--no-start started the service"
called "systemctl daemon-reload" && called "systemctl enable aphelion.service" || fail "the installer didn't reload systemd and enable the unit"
grep -q "sudo aphelion" /tmp/installer-out || fail "the installer didn't say what to do next"
pass "a fresh install with --no-start installs Docker, clones the tag, writes .env, downloads and tags the image, runs host/install, and leaves the service stopped"

before=$(snapshot)
reset_calls
run_installer --tag v9.9.9 --no-start || fail "a second install failed: $(cat /tmp/installer-out)"
[[ $(snapshot) == "$before" ]] || fail "a second install changed files: $(diff <(echo "$before") <(snapshot))"
! grep -qE "apt-get|git (clone|fetch|checkout)|docker (pull|tag|compose.*build)|systemctl (start|restart|daemon-reload|enable aphelion)" "$FAKE_CALLS" ||
  fail "a second install repeated a step: $(cat "$FAKE_CALLS")"
grep -q "already" /tmp/installer-out || fail "a second install didn't say that the steps were done"
pass "a second run changes no file, runs no install, clone, download, reload, enable or start, and says each step is done"

echo ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000009 >"$FAKE_STATE/local"
reset_calls
run_installer --tag v9.9.9 --no-start || fail "a rerun over a stale image failed: $(cat /tmp/installer-out)"
called "docker pull" && called "docker tag $FAKE_DIGEST_LINE aphelion:local" && [[ $(cat "$FAKE_STATE/local") == "$FAKE_DIGEST_LINE" ]] ||
  fail "a rerun at the same tag kept a stale image: $(cat "$FAKE_CALLS")"
pass "a rerun at the same tag replaces an image that doesn't carry the release's digest"

echo "# local edit" >/opt/aphelion/.git/dirty
status=0
run_installer --tag v9.8.8 --no-start || status=$?
[[ $status == 1 ]] && grep -q "local changes" /tmp/installer-out && ! called "git checkout" ||
  fail "the installer moved a checkout that has local changes ($status)"
rm /opt/aphelion/.git/dirty
reset_calls
FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000003 \
  run_installer --tag v9.8.8 --no-start || fail "moving to another tag failed: $(cat /tmp/installer-out)"
ordered "fetch --tags" "checkout --quiet tags/v9.8.8" || fail "the installer didn't fetch before it moved to the tag: $(cat "$FAKE_CALLS")"
called "docker pull" || fail "the installer kept the image of another tag"
pass "the installer refuses a checkout with local changes, and moves a clean one to another tag, fetching first and downloading that tag's image"

fresh_host
export FAKE_DIGEST_FILE=present FAKE_PULLED=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000002
status=0
run_installer --tag v9.9.9 --no-start || status=$?
[[ $status != 0 ]] && grep -q "digest" /tmp/installer-out || fail "the installer accepted an image with another digest ($status)"
! called "docker tag" && ! called "compose --project-directory /opt/aphelion/deploy build" && ! called "--new-key" && [[ ! -e $FAKE_STATE/local && ! -e $unit ]] ||
  fail "the installer went on after a wrong digest: $(cat "$FAKE_CALLS")"
pass "the installer refuses an image whose digest differs, and tags, builds and installs nothing"

fresh_host
export FAKE_DIGEST_FILE=present FAKE_PULL=fail
run_installer --tag v9.9.9 --no-start || fail "the installer stopped when the download failed: $(cat /tmp/installer-out)"
called "docker compose --project-directory /opt/aphelion/deploy build" && ! called "docker tag" && [[ -e $FAKE_STATE/local && -f $unit ]] ||
  fail "a failed download didn't fall back to a build: $(cat "$FAKE_CALLS")"
pass "the installer builds the image on the host when the download fails"

fresh_host
run_installer --tag v9.9.9 --no-start || fail "the installer stopped when the release had no digest: $(cat /tmp/installer-out)"
called "docker compose --project-directory /opt/aphelion/deploy build" && ! called "docker pull" ||
  fail "a missing digest file didn't fall back to a build: $(cat "$FAKE_CALLS")"
pass "the installer builds the image on the host when the release has no digest file"

fresh_host
export FAKE_DIGEST_FILE=present FAKE_DIGEST_LINE='ghcr.io/other/aphelion@sha256:00'
status=0
run_installer --tag v9.9.9 --no-start || status=$?
export FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000001
[[ $status != 0 ]] && ! called "docker pull" && ! called " build" || fail "the installer used a digest file that isnt one image reference ($status): $(cat /tmp/installer-out) $(cat "$FAKE_CALLS")"
pass "the installer refuses a digest file that isn't one ghcr.io/jcore9/aphelion@sha256 reference"

fresh_host
export FAKE_DIGEST_FILE=present
status=0
run_installer --tag v9.9.9 || status=$?
[[ $status == 1 ]] && grep -q "terminal" /tmp/installer-out && grep -q "recovery" /tmp/installer-out && ! called "systemctl start" ||
  fail "without a terminal the installer didn't stop before the recovery key and the start ($status): $(cat /tmp/installer-out)"
! grep -q "AGE-SECRET-KEY-1FAKE" /tmp/installer-out || fail "the installer printed the key without a terminal"
[[ -f $credential ]] || fail "the installer didn't create the key before it stopped"
pass "without a terminal the installer stops before the recovery key and the start, and says how to finish"

reset_calls
printf 'wrong\nsaved\n' | script -qec "bash -s -- --tag v9.9.9 </opt/aphelion/deploy/install.sh" /tmp/installer-tty >/dev/null 2>&1 || fail "the installer failed with a terminal: $(cat /tmp/installer-tty)"
grep -q "AGE-SECRET-KEY-1FAKE" /tmp/installer-tty && called "systemctl start aphelion" ||
  fail "with a terminal the installer didn't show the key and start the service: $(cat /tmp/installer-tty)"
! called "docker compose --profile" && ! called "compose --project-directory /opt/aphelion/deploy run" ||
  fail "the installer ran the preflight itself, which needs the credential that only the running unit has: $(cat "$FAKE_CALLS")"
reset_calls
before=$(snapshot)
run_installer --tag v9.9.9 || fail "a second run of a started install failed: $(cat /tmp/installer-out)"
[[ $(snapshot) == "$before" ]] && ! called "systemctl start" && ! grep -q "AGE-SECRET-KEY" /tmp/installer-out ||
  fail "a second run of a started install changed something or showed the key"
pass "with a terminal the installer shows the key until you type saved, then starts the service, and a second run neither shows the key nor starts it again"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the truncation test: $(cat /tmp/installer-out)"
fresh_host
total=$(wc -l <"$installer_template/deploy/install.sh")
install_block=$(grep -n "apt-get install" "$installer_template/deploy/install.sh" | head -n 1 | cut -d: -f1)
for lines in 20 "$((total / 2))" "$((install_block + 1))" "$((total - 1))"; do
  status=0
  head -n "$lines" "$installer_template/deploy/install.sh" | bash -s -- --tag v9.9.9 >/tmp/installer-out 2>&1 || status=$?
  [[ ! -s $FAKE_CALLS && ! -e /opt/aphelion && ! -e $unit && ! -e $credential ]] ||
    fail "a script cut after $lines lines changed the host: $(cat "$FAKE_CALLS")"
done
pass "a download cut short runs nothing"

fresh_host
mkdir -p /etc/ufw
printf 'ENABLED=yes\n' >/etc/ufw/ufw.conf
printf 'MANAGE_BUILTINS=yes\n' >/etc/default/ufw
for flags in "" "--no-start"; do
  status=0
  # shellcheck disable=SC2086
  run_installer --tag v9.9.9 $flags || status=$?
  [[ $status == 1 ]] && grep -q "MANAGE_BUILTINS=no" /tmp/installer-out && [[ ! -s $FAKE_CALLS && ! -e /opt/aphelion ]] ||
    fail "the installer went on with ufw enabled and MANAGE_BUILTINS=yes ($status, '$flags'): $(cat /tmp/installer-out)"
done
printf 'MANAGE_BUILTINS=no\n' >/etc/default/ufw
run_installer --tag v9.9.9 --no-start || fail "the installer refused MANAGE_BUILTINS=no: $(cat /tmp/installer-out)"
pass "the installer reads ufw before it changes anything, with or without --no-start, and refuses enabled ufw with MANAGE_BUILTINS=yes"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the checkout tests: $(cat /tmp/installer-out)"
refuses_checkout() {
  local message=$1 status=0 before
  before=$(snapshot)
  reset_calls
  run_installer --tag v9.9.9 --no-start || status=$?
  [[ $status == 1 ]] && grep -q "$message" /tmp/installer-out && ! called "git -C /opt/aphelion fetch" && ! called "git -C /opt/aphelion checkout" &&
    ! called "docker" && ! called "apt-get" && [[ $(snapshot) == "$before" ]] ||
    fail "the installer used a checkout it shouldn't ($message, $status): $(cat /tmp/installer-out) $(cat "$FAKE_CALLS")"
}
chown nobody /opt/aphelion
refuses_checkout "owned by root"
chown root /opt/aphelion
chmod 0775 /opt/aphelion
refuses_checkout "writable"
chmod 0757 /opt/aphelion
refuses_checkout "writable"
chmod 0755 /opt/aphelion
FAKE_ORIGIN=https://example.com/other.git
export FAKE_ORIGIN
refuses_checkout "isn't a clone of"
unset FAKE_ORIGIN
FAKE_STATUS_FAIL=1
export FAKE_STATUS_FAIL
refuses_checkout "git status"
unset FAKE_STATUS_FAIL
chmod 0664 /opt/aphelion/.git/tag
refuses_checkout "/opt/aphelion/.git/tag"
chmod 0644 /opt/aphelion/.git/tag
chmod 0666 /opt/aphelion/deploy/host/get-image
refuses_checkout "/opt/aphelion/deploy/host/get-image"
chmod 0755 /opt/aphelion/deploy/host/get-image
chown nobody /opt/aphelion/deploy/host
refuses_checkout "/opt/aphelion/deploy/host"
chown root /opt/aphelion/deploy/host
mv /opt/aphelion/.git /opt/aphelion-git
ln -s /opt/aphelion-git /opt/aphelion/.git
refuses_checkout "symbolic link"
rm /opt/aphelion/.git
mv /opt/aphelion-git /opt/aphelion/.git
mv /opt/aphelion /opt/aphelion-real
ln -s /opt/aphelion-real /opt/aphelion
refuses_checkout "symbolic link"
rm /opt/aphelion
mv /opt/aphelion-real /opt/aphelion
run_installer --tag v9.9.9 --no-start || fail "the installer refused a checkout that only root can write: $(cat /tmp/installer-out)"
pass "the installer refuses a checkout with a file that isn't root's or that others can write, naming it, a symbolic link for the checkout or its .git, an origin that differs, or a failed git status, before it changes anything"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the running-service tests: $(cat /tmp/installer-out)"
touch "$FAKE_STATE/active"
before=$(snapshot)
reset_calls
status=0
run_installer --tag v9.9.9 --no-start || status=$?
[[ $status == 1 ]] && grep -q "running" /tmp/installer-out && grep -q "systemctl stop" /tmp/installer-out && [[ $(snapshot) == "$before" ]] && ! grep -qE "apt-get|git (clone|fetch|checkout)|docker (pull|tag|compose.*build)" "$FAKE_CALLS" ||
  fail "--no-start went on with a running service ($status): $(cat /tmp/installer-out)"
status=0
FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000003 \
  run_installer --tag v9.8.8 || status=$?
[[ $status == 1 ]] && grep -q "aphelion upgrade" /tmp/installer-out && [[ $(snapshot) == "$before" && $(cat /opt/aphelion/.git/tag) == v9.9.9 ]] && ! grep -qE "apt-get|git (clone|fetch|checkout)|docker (pull|tag|compose.*build)" "$FAKE_CALLS" ||
  fail "a tag change went on with a running service ($status): $(cat /tmp/installer-out)"
grep -q -e "--no-optional-locks -C /opt/aphelion status" "$FAKE_CALLS" || fail "git status could rewrite the index: $(cat "$FAKE_CALLS")"
rm -rf /opt/aphelion
reset_calls
status=0
run_installer --tag v9.9.9 || status=$?
[[ $status == 1 && ! -e /opt/aphelion ]] && grep -q "aphelion upgrade" /tmp/installer-out && ! grep -qE "apt-get|git (clone|fetch|checkout)|docker (pull|tag|compose.*build)" "$FAKE_CALLS" ||
  fail "a missing checkout went on with a running service ($status): $(cat /tmp/installer-out)"
pass "the installer refuses --no-start and a tag change while the service runs, and a service that runs with no checkout, changes nothing, and points to aphelion upgrade"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the mismatch test: $(cat /tmp/installer-out)"
local_before=$(cat "$FAKE_STATE/local")
status=0
FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000003 \
  FAKE_PULLED=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000002 \
  run_installer --tag v9.8.8 --no-start || status=$?
[[ $status != 0 && $(cat /opt/aphelion/.git/tag) == v9.9.9 && $(cat "$FAKE_STATE/local") == "$local_before" ]] && grep -q "v9.9.9" /tmp/installer-out && grep -qi "back" /tmp/installer-out ||
  fail "a digest mismatch left the checkout or the image changed ($status): $(cat /tmp/installer-out)"
pass "a digest mismatch after a tag change puts the checkout back on the commit it was on and leaves the image alone"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the branch test: $(cat /tmp/installer-out)"
echo main >/opt/aphelion/.git/branch
echo main >/opt/aphelion/.git/branchname
cp /opt/aphelion/.git/tag /opt/aphelion/.git/branchtip
status=0
FAKE_DIGEST_LINE=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000003 \
  FAKE_PULLED=ghcr.io/jcore9/aphelion@sha256:0000000000000000000000000000000000000000000000000000000000000002 \
  run_installer --tag v9.8.8 --no-start || status=$?
[[ $status != 0 && $(cat /opt/aphelion/.git/tag) == v9.9.9 && $(cat /opt/aphelion/.git/branch 2>/dev/null) == main ]] ||
  fail "a digest mismatch didn't put the checkout back on its branch ($status, branch '$(cat /opt/aphelion/.git/branch 2>/dev/null)'): $(cat /tmp/installer-out)"
called "git -C /opt/aphelion switch --quiet -- main" || fail "the rollback didn't switch to the branch by name, so a tag of the same name could detach it: $(cat "$FAKE_CALLS")"
pass "a digest mismatch puts a checkout that was on a branch back on that branch and commit"

fresh_host
export FAKE_DIGEST_FILE=present
run_installer --tag v9.9.9 --no-start || fail "a fresh install failed before the reload test: $(cat /tmp/installer-out)"
echo "# older unit" >>"$unit"
status=0
FAKE_RELOAD_FAIL_ONCE=1 run_installer --tag v9.9.9 --no-start || status=$?
[[ $status != 0 && -e $FAKE_STATE/needreload ]] || fail "the reload test didn't fail the first reload ($status)"
cmp -s /opt/aphelion/deploy/host/aphelion.service "$unit" || fail "the new unit wasn't in place after the failed reload"
reset_calls
FAKE_RELOAD_FAIL_ONCE=1 run_installer --tag v9.9.9 --no-start || fail "the rerun after a failed reload failed: $(cat /tmp/installer-out)"
called "systemctl daemon-reload" && [[ ! -e $FAKE_STATE/needreload ]] || fail "the rerun didn't reload systemd after the failed reload: $(cat "$FAKE_CALLS")"
reset_calls
run_installer --tag v9.9.9 --no-start || fail "a third run failed: $(cat /tmp/installer-out)"
! called "systemctl daemon-reload" || fail "a third run reloaded systemd with nothing to reload"
pass "a rerun reloads systemd after a failed reload even though the unit file is already current, and reloads nothing once systemd is current"

for direct in "" "v1" "v9.9.9 extra" "--x"; do
  status=0
  # shellcheck disable=SC2086
  "$installer_template/deploy/host/get-image" $direct >/dev/null 2>&1 || status=$?
  [[ $status == 2 ]] || fail "get-image accepted '$direct' ($status)"
done
pass "get-image takes one tag, and refuses anything else"
