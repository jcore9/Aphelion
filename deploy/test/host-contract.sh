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
    exit 0 ;;
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
  *" --user harness aphelion aphelion plugin "*)
    all="$*"
    echo "ran plugin ${all##* aphelion plugin }"
    exit "${FAKE_PLUGIN_EXIT:-0}" ;;
  *" --user harness aphelion test -e "*)
    last=${*: -1}
    [[ " ${FAKE_PLUGINS:-} " == *" ${last##*/} "* ]]
    exit ;;
  *" --user aphelion-bot aphelion "*" auth login "* | *" --user aphelion-bot aphelion "*" login --device-auth "*)
    echo "SECRET-FROM-THE-TOOL"
    exit "${FAKE_SIGN_IN_EXIT:-0}" ;;
  *" --user aphelion-bot aphelion "*)
    all="$*"
    rest=${all#*--user aphelion-bot aphelion }
    echo "SECRET-FROM-THE-TOOL"
    [[ " ${FAKE_SIGNED_IN:-} " == *" ${rest%% *} "* ]]
    exit ;;
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

status=0
error=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$link" status 2>&1 >/dev/null) || status=$?
[[ $status == 2 && $error == "Run it with sudo: sudo aphelion status" ]] ||
  fail "the command didn't refuse a user other than root with status 2: $status $error"
help=$(setpriv --reuid=65534 --regid=65534 --clear-groups "$link" --help) || fail "--help needs root"
[[ $help == *"aphelion status"* && $help == *"aphelion check"* && $help == *"aphelion device add NAME"* && $help == *"aphelion tool install NAME"* ]] ||
  fail "--help doesn't list the commands: $help"
pass "the command refuses a user other than root with status 2, and --help works for everyone"

for bad in "" bogus "status extra" device "device frobnicate" "check now" "device add" "device list extra" "device revoke" "device revoke a b" tool "tool frobnicate" "tool list extra" "tool install" "tool install a b" "tool remove" "tool remove a b" "tool update a b" "tool check a" "tool check now please" \
  sign-in "sign-in a b" "backup extra" "backup --to" "backup --to a b" "restore a b" \
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
pass "sign-in refuses an unknown tool, a tool that isn't installed, and a run without a terminal"

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
pass "backup --to writes into the given folder, and leaves a service that isn't running alone"

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
pass "restore refuses an archive whose checksum is wrong or missing before it touches the host"

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
pass "plugin install copies a host folder into the container, refuses a folder that is already there, and after --approve names the next step"

mkdir -p "$(dirname "$source_folder")/bad name" "$(dirname "$source_folder")/-flag" "$(dirname "$source_folder")/my-plugin@1.0.0"
touch "$(dirname "$source_folder")/a-file"
for bad in "bad name" -flag my-plugin@1.0.0 a-file missing; do
  reset_calls
  status=0
  out=$(as_root_aphelion plugin install "$(dirname "$source_folder")/$bad" 2>&1) || status=$?
  [[ $status == 1 && $out == "aphelion: "* ]] || fail "plugin install accepted '$bad' ($status, $out)"
  ! called " cp " && ! called "plugin install" || fail "plugin install went on with '$bad'"
done
pass "plugin install refuses a name that isn't a plain folder name, a file, and a folder that doesn't exist"
