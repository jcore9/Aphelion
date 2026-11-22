#!/bin/bash
# codex-acp under root-owned requirements (untrusted only). Spike code. Never merged.
set -u
export CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x CODEX_PATH=/usr/local/bin/codex
mkdir -p $CODEX_HOME /tmp/mock /home/aphelion-agent/ws; echo hello > /home/aphelion-agent/ws/hello.txt
sed -n '/^cat > \$CODEX_HOME\/config.toml/,/^CFG$/p' /opt/spike/req-test2.sh | sed '1d;$d' > $CODEX_HOME/config.toml
cp /opt/spike/s-matrix.json /tmp/mock/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 /tmp/mock/script.json /tmp/mock/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
sleep 0.7
for mode in none read-only agent-full-access; do
  curl -s -X POST localhost:18080/reset >/dev/null
  echo "=== mode $mode"
  extra=""; [ $mode != none ] && extra="--mode $mode"
  timeout 60 bun /opt/spike/acp-probe.ts --cwd /home/aphelion-agent/ws --prompt go $extra -- bun /opt/spike/codex-acp-270/index.js 2>/tmp/acp.err | grep -E '"(session_new|mode_set|permission_request|tool_call|error|prompt_done)"' | cut -c30-260
  grep -iE "error|disallowed" /tmp/acp.err | grep -v "PATH aliases" | head -3 | cut -c1-300
done
