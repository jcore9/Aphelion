#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if bun "$root/scripts/create-plugin.ts" "$work/refused" --repository https://github.com/octo-org/hello-plugin 2>/dev/null; then
  echo "create-plugin accepted a repository URL" >&2
  exit 1
fi

bun "$root/scripts/create-plugin.ts" "$work/hello-plugin" --repository octo-org/hello-plugin
cd "$work/hello-plugin"
bun install
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun "$root/scripts/check-plugin-workflows.ts" "$work/hello-plugin"

repository=$(bun --print 'require("./dist/aphelion-plugin.json").repository')
if [ "$repository" != "octo-org/hello-plugin" ]; then
  echo "dist/aphelion-plugin.json names the repository $repository" >&2
  exit 1
fi

bun run package
archive="$work/hello-plugin/release/aphelion-plugin.tar"
if ! cmp -s <(head -c 265 "$archive" | tail -c 8) <(printf 'ustar\x0000'); then
  echo "release/aphelion-plugin.tar isn't a POSIX ustar archive" >&2
  exit 1
fi
if tar -tvf "$archive" | grep -v '^[-d]'; then
  echo "release/aphelion-plugin.tar holds an entry that isn't a file or a folder" >&2
  exit 1
fi
entry=$(bun --print 'require("./dist/aphelion-plugin.json").server.entry')
for name in aphelion-plugin.json "$entry"; do
  if ! tar -tf "$archive" | grep -qxF "./$name"; then
    echo "release/aphelion-plugin.tar has no $name at its root" >&2
    exit 1
  fi
done
bun "$root/scripts/check-plugin-archive.ts" "$archive" "$work/unpacked"
diff -r dist "$work/unpacked"

mkdir "$work/installed"
tar -xf "$archive" -C "$work/installed"
diff -r dist "$work/installed"
if [ -n "$(find "$work/installed" -type l)" ]; then
  echo "the release archive holds a symbolic link" >&2
  exit 1
fi
if [ -e "$work/installed/node_modules" ]; then
  echo "the release archive holds node_modules" >&2
  exit 1
fi

cd "$work"
bun "$root/scripts/check-plugin-bundle.ts" "$work/installed"
