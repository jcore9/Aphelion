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

as_user() {
  local account=$1
  shift
  setpriv --reuid "$account" --regid "$account" --init-groups --inh-caps=-all "$@"
}

start_broker() {
  setpriv --reuid aphelion-secrets --regid aphelion-secrets --init-groups --inh-caps=-all \
    /broker >>/broker.log 2>&1 &
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

trap 'kill -TERM "${broker:-}" 2>/dev/null || true' EXIT
start_broker
as_user harness bun /check/broker-probe.mjs write
for account in harness aphelion-bot aphelion-plugins; do
  as_user "$account" test ! -r /var/lib/aphelion-secrets/identity.agekey
done
for account in aphelion-bot aphelion-plugins; do
  as_user "$account" bun /check/broker-probe.mjs denied
  echo "$account received EACCES"
done
if as_user aphelion-secrets /broker >>/broker.log 2>&1; then
  echo "A second broker started on the same socket" >&2
  exit 1
fi
as_user harness bun /check/broker-probe.mjs read
stop_broker
start_broker
as_user harness bun /check/broker-probe.mjs read
stop_broker
grep -q 'Secrets broker startup failed' /broker.log
if grep -arq 'broker-canary-' /broker.log /var/lib/aphelion-secrets; then
  echo "Plaintext canary reached a broker log or store file" >&2
  exit 1
fi
echo "harness read the encrypted secret across broker restart"
