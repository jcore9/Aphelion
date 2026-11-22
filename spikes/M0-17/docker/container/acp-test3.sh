#!/bin/bash
# codex-acp with a managed custom permission profile and untrusted pinned. Spike code. Never merged.
set -u
export CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x CODEX_PATH=/usr/local/bin/codex
mkdir -p $CODEX_HOME /tmp/mock /home/aphelion-agent/ws; echo hello > /home/aphelion-agent/ws/hello.txt
sed -n '/^cat > \$CODEX_HOME\/config.toml/,/^CFG$/p' /opt/spike/req-test2.sh | sed '1d;$d' > $CODEX_HOME/config.toml
sed -i "1i approval_policy = \"untrusted\"" $CODEX_HOME/config.toml; head -2 $CODEX_HOME/config.toml
cp /opt/spike/s-matrix.json /tmp/mock/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 /tmp/mock/script.json /tmp/mock/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
setsid python3 -I /opt/spike/harness.py allow </dev/null >/dev/null 2>&1 &
sleep 0.7
for mode in none workspace-write; do
  curl -s -X POST localhost:18080/reset >/dev/null; : > /tmp/mock/log.jsonl
  echo "=== mode $mode"; extra=""; [ $mode != none ] && extra="--mode $mode"
  timeout 60 bun /opt/spike/acp-probe.ts --cwd /home/aphelion-agent/ws --prompt go $extra -- bun /opt/spike/codex-acp-270/index.js 2>/tmp/acp.err | python3 -I /opt/spike/acp_summary.py
  grep -iE "error|disallowed" /tmp/acp.err | grep -v "PATH aliases" | head -2 | cut -c1-250
  python3 -I -c "import json;r=[json.loads(l)['data'] for l in open('/tmp/mock/log.jsonl') if json.loads(l)['event']=='request'];print('  web_search tool offered:', 'web_search' in (r[0]['tools'] if r else []))"
done
