#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

bun "$root/scripts/create-plugin.ts" "$work/hello-plugin"
cd "$work/hello-plugin"
bun install
bun run typecheck
bun run test
bun run build

mkdir "$work/installed"
cp -R dist/. "$work/installed/"
if [ -n "$(find "$work/installed" -type l)" ]; then
  echo "dist/ holds a symbolic link" >&2
  exit 1
fi
if [ -e "$work/installed/node_modules" ]; then
  echo "dist/ holds node_modules" >&2
  exit 1
fi

cd "$work"
bun "$root/scripts/check-plugin-bundle.ts" "$work/installed"
