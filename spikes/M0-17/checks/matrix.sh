#!/bin/bash
# Runs one scripted mock turn per approval setting and prints, for each tool call,
# whether Codex sent an approval request before running it. Spike code for M0-17. Never merged.
# matrix.sh LABEL SCRIPT_JSON PROBE_ARGS...   (env: CODEX_HOME, CODEX_BIN, WS, OUT, MOCK_DIR)
set -u
label=$1; script=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
rm -rf "$WS" && mkdir -p "$WS" && echo hello > "$WS/hello.txt"
cp "$script" "$MOCK_DIR/script.json"; : > "$MOCK_DIR/log.jsonl"
curl -s -X POST http://127.0.0.1:18080/reset >/dev/null
MOCK_KEY=x timeout 90 "${BUN:-$HOME/.bun/bin/bun}" "$here/app-server-probe.ts" --cwd "$WS" --timeout 60000 "$@" -- ${CODEX_BIN:-codex} app-server > "$OUT/$label.jsonl" 2> "$OUT/$label.stderr"
python3 -I "$here/summarize.py" "$label" "$OUT/$label.jsonl" "$WS"
