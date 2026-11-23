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
