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
case $1 in
  is-enabled) echo enabled ;;
  is-active) echo "${FAKE_SERVICE:-active}"; [[ ${FAKE_SERVICE:-active} == active ]] ;;
esac
FAKE
cat >"$fakebin/curl" <<'FAKE'
#!/bin/bash
[[ ${FAKE_CONTAINER:-up} == up && ${*: -1} == http://100.100.5.1:7400/health ]] || exit 7
echo '{"status":"ok"}'
FAKE
cat >"$fakebin/docker" <<'FAKE'
#!/bin/bash
case " $* " in
  *" ps "*)
    [[ ${FAKE_CONTAINER:-up} == up ]] && echo fake-container-id
    exit 0 ;;
  *" --user harness aphelion aphelion device "*)
    echo "the-token"
    echo "Added device" >&2
    exit "${FAKE_DEVICE_EXIT:-0}" ;;
  *" --user harness aphelion aphelion tool list"*)
    printf 'NAME\tVERSION\tSTATE\tSTATUS-COMMAND\n'
    for entry in "claude 2.1.330 claude auth status --text" "codex 0.172.0 codex login status" "grok 1.0.92 -" "opencode 2.4.1 -"; do
      read -r name version status <<<"$entry"
      state="not installed"
      [[ " ${FAKE_TOOLS:-} " == *" $name "* ]] && state=installed
      printf '%s\t%s\t%s\t%s\n' "$name" "$version" "$state" "$status"
    done
    exit "${FAKE_TOOL_EXIT:-0}" ;;
  *" --user harness aphelion aphelion tool "*)
    all="$*"
    echo "ran tool ${all##* aphelion tool }"
    exit "${FAKE_TOOL_EXIT:-0}" ;;
  *" --user aphelion-bot aphelion "*)
    all="$*"
    rest=${all#*--user aphelion-bot aphelion }
    echo "SECRET-FROM-THE-TOOL"
    [[ " ${FAKE_SIGNED_IN:-} " == *" ${rest%% *} "* ]]
    exit ;;
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

for bad in "" bogus "status extra" device "device frobnicate" "check now" "device add" "device list extra" "device revoke" "device revoke a b" tool "tool frobnicate" "tool list extra" "tool install" "tool install a b" "tool remove" "tool remove a b"; do
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
grep -qP "^grok\t1\.0\.92\tinstalled\t-$" <<<"$rows" || fail "tool list didn't pass the server's table through: $rows"
pass "tool list, install and remove run the server's command as harness and pass its output and exit code through"
