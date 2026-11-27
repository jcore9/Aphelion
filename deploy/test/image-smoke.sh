#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/../.."
readonly project=aphelion-smoke
readonly image=aphelion:smoke
readonly service=aphelion
readonly port=17401
scratch=$(mktemp -d)
chmod 0755 "$scratch"

export APHELION_TAILNET_ADDRESS=127.0.0.1
export APHELION_SUBNET=172.30.98.0/24

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

cat >"$scratch/override.yaml" <<YAML
services:
  $service:
    image: $image
    ports: !override ["127.0.0.1:$port:7400"]
    secrets: [bootstrap]
networks:
  aphelion:
    name: aphelion-smoke
    driver_opts:
      com.docker.network.bridge.name: aphsmoke0
secrets:
  bootstrap:
    file: $scratch/secrets/bootstrap
YAML
compose=(docker compose -p "$project" -f deploy/compose.yaml -f "$scratch/override.yaml")

cleanup() {
  status=$?
  if ((status != 0)); then
    "${compose[@]}" logs --no-color 2>&1 | tail -n 60 >&2 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  as_root rm -rf /scratch/secrets >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

mkdir "$scratch/secrets"
"${compose[@]}" build --quiet
machine=$(docker run --rm --entrypoint uname "$image" -m)
echo "image built for $machine"

as_root bash -c 'aphelion-secrets --new-key >/scratch/secrets/bootstrap && chmod 0400 /scratch/secrets/bootstrap'
"${compose[@]}" up --detach --quiet-pull >/dev/null 2>&1
container=$("${compose[@]}" ps --quiet "$service")

for ((tries = 0; tries < 300; tries++)); do
  [[ $(curl --silent --max-time 2 "http://127.0.0.1:$port/health" || true) == '{"status":"ok"}' ]] && break
  sleep 0.2
done
[[ $(curl --silent --max-time 5 "http://127.0.0.1:$port/health") == '{"status":"ok"}' ]] ||
  fail "/health did not answer"
pass "the server starts and /health answers"

listed=$(docker exec --user harness "$container" aphelion tool list)
echo "$listed"
[[ $listed == *$'\nclaude\t'*$'\tnot installed\t'* ]] || fail "tool list doesn't show claude as installable on $machine"
pass "tool list offers claude on $machine"

installed=$(docker exec --user harness "$container" aphelion tool install claude 2>&1) || fail "tool install claude failed: $installed"
echo "$installed"
[[ $installed == "Installed claude "* ]] || fail "tool install printed something else: $installed"

version=$(docker exec --user aphelion-bot "$container" claude --version 2>&1) || fail "claude --version failed: $version"
echo "$version"
listed_version=$(awk -F'\t' '$1 == "claude" { print $2 }' <<<"$listed")
[[ $version == *"$listed_version"* ]] || fail "claude --version printed $version, not the listed $listed_version"
pass "claude --version runs as aphelion-bot"
