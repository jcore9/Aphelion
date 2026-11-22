#!/bin/bash
# app-server matrix under req3 (managed profile, web search off, strict hook). Spike code. Never merged.
set -u
export BUN=/usr/local/bin/bun CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x WS=/home/aphelion-agent/ws OUT=/tmp/out MOCK_DIR=/tmp/mock CODEX_BIN=codex
mkdir -p $CODEX_HOME $OUT $MOCK_DIR
sed -n '/^cat > \$CODEX_HOME\/config.toml/,/^CFG$/p' /opt/spike/req-test2.sh | sed '1d;$d' > $CODEX_HOME/config.toml
echo 'web_search = "live"' | cat - $CODEX_HOME/config.toml > /tmp/c && cp /tmp/c $CODEX_HOME/config.toml
echo '[]' > $MOCK_DIR/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 $MOCK_DIR/script.json $MOCK_DIR/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
setsid python3 -I /opt/spike/harness.py allow </dev/null >/dev/null 2>&1 &
sleep 0.7
/opt/spike/matrix.sh req3 /opt/spike/s-matrix.json --prompt go
grep '"thread/start"' $OUT/req3.jsonl | cut -c1-300
python3 -I -c "import json;r=[json.loads(l)['data'] for l in open('$MOCK_DIR/log.jsonl') if json.loads(l)['event']=='request'];print('web_search tool offered:', 'web_search' in r[0]['tools'], r[0]['tools'])"
