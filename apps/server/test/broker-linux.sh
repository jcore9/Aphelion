#!/bin/bash
set -euo pipefail

if [[ "${1:-}" != "--container" ]]; then
  cd "$(dirname "$0")/../../.."
  bun run --filter @aphelion/server build:broker
  exec docker run --rm --network none \
    --mount "type=bind,source=$PWD/apps/server/dist/aphelion-secrets,target=/broker,readonly" \
    --mount "type=bind,source=$PWD/apps/server/test,target=/check,readonly" \
    --mount "type=bind,source=$(realpath "$(command -v bun)"),target=/usr/local/bin/bun,readonly" \
    ubuntu:26.04 bash /check/broker-linux.sh --container
fi

useradd --uid 10003 --user-group aphelion-secrets
for account in harness aphelion-bot aphelion-plugins; do
  useradd --system --user-group "$account"
done
install -d -o aphelion-secrets -g harness -m 2710 /run/aphelion-secrets
install -d -o aphelion-secrets -g aphelion-secrets -m 0700 /var/lib/aphelion-secrets
(umask 077 && /broker --new-key >/bootstrap && /broker --new-key >/other-key)
chmod 0400 /bootstrap /other-key
grep -qEx 'AGE-SECRET-KEY-1[0-9A-Z]{58}' /bootstrap

as_user() {
  local account=$1
  shift
  setpriv --reuid "$account" --regid "$account" --init-groups --inh-caps=-all "$@"
}

start_broker() {
  setpriv --reuid aphelion-secrets --regid aphelion-secrets --init-groups --inh-caps=-all \
    /broker </bootstrap >>/broker.log 2>&1 &
  broker=$!
  for ((attempt = 0; attempt < 100; attempt++)); do
    if [[ "$(stat -c '%a' /run/aphelion-secrets/broker.sock 2>/dev/null)" == 660 ]]; then
      return 0
    fi
    if ! kill -0 "$broker" 2>/dev/null; then
      cat /broker.log >&2
      return 1
    fi
    sleep .05
  done
  cat /broker.log >&2
  return 1
}

stop_broker() {
  kill -TERM "$broker"
  wait "$broker"
}

trap 'if [[ -n "${broker:-}" ]]; then kill -TERM "$broker" 2>/dev/null || true; fi' EXIT

chgrp aphelion-bot /run/aphelion-secrets
chmod 2710 /run/aphelion-secrets
if timeout 5s setpriv --reuid aphelion-secrets --regid aphelion-secrets --init-groups --inh-caps=-all \
    /broker </bootstrap >>/broker.log 2>&1; then
  echo "The broker accepted the bot group on its socket directory" >&2
  exit 1
else
  status=$?
  [[ "$status" == 1 ]]
fi
test ! -e /run/aphelion-secrets/broker.sock
chgrp harness /run/aphelion-secrets
chmod 2710 /run/aphelion-secrets
start_broker
as_user harness bun /check/broker-probe.mjs write
test ! -e /var/lib/aphelion-secrets/identity.agekey
[[ $(stat -c '%U %a' /var/lib/aphelion-secrets/recipient.pub) == "aphelion-secrets 600" ]]
for account in aphelion-bot aphelion-plugins; do
  as_user "$account" bun /check/broker-probe.mjs denied
  echo "$account received EACCES"
done
if as_user aphelion-secrets /broker </bootstrap >>/broker.log 2>&1; then
  echo "A second broker started on the same socket" >&2
  exit 1
fi
as_user harness bun /check/broker-probe.mjs read
stop_broker
start_broker
as_user harness bun /check/broker-probe.mjs read
as_user harness bun /check/broker-probe.mjs delete
stop_broker

refused() {
  local input=$1 reason=$2
  : >/refused.log
  if as_user aphelion-secrets /broker <"$input" >/refused.log 2>&1; then
    echo "The broker started with $input on standard input" >&2
    exit 1
  fi
  grep -qF "\"msg\":\"Secrets broker startup failed\",\"reason\":\"$reason\"" /refused.log || {
    cat /refused.log >&2
    exit 1
  }
  cat /refused.log >>/broker.log
}
refused /dev/null "The bootstrap key is missing from standard input"
refused /other-key "The bootstrap key does not match this secrets store"
test ! -e /run/aphelion-secrets/broker.sock
echo "the broker refused an empty standard input and a key that doesn't match the store"

grep -q 'Secrets broker startup failed' /broker.log
for secret in "$(cat /bootstrap)" "$(cat /other-key)"; do
  if grep -arF -- "$secret" /broker.log /var/lib/aphelion-secrets >/dev/null; then
    echo "A bootstrap key reached a broker log or store file" >&2
    exit 1
  fi
done
status=0
grep -ar 'broker-canary-' /broker.log /var/lib/aphelion-secrets >/dev/null || status=$?
case "$status" in
  1) ;;
  0) echo "Plaintext canary reached a broker log or store file" >&2; exit 1 ;;
  *) echo "Could not scan broker logs and store files" >&2; exit 1 ;;
esac
echo "harness read the encrypted secret across broker restart, then deleted it"
