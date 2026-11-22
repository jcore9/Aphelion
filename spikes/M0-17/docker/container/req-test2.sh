#!/bin/bash
# Second pass of the M0-17 managed-config checks. Spike code. Never merged.
set -u
export BUN=/usr/local/bin/bun CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x WS=/home/aphelion-agent/ws OUT=/tmp/out MOCK_DIR=/tmp/mock CODEX_BIN=codex
mkdir -p $CODEX_HOME $OUT $MOCK_DIR
cat > $CODEX_HOME/config.toml <<'CFG'
model = "gpt-5.5"
model_provider = "mock"
[model_providers.mock]
name = "mock"
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
env_key = "MOCK_KEY"
supports_websockets = false
[mcp_servers.probe]
command = "/usr/local/bin/bun"
args = ["/opt/spike/mcp-probe-server.ts"]
CFG
echo '[]' > $MOCK_DIR/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 $MOCK_DIR/script.json $MOCK_DIR/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
sleep 0.7
echo "### exec --dangerously-bypass-approvals-and-sandbox (full output)"
mkdir -p $WS; echo '[{"call":"exec_command","args":{"cmd":"echo bypassed > bypass.txt; id -u"}},{"say":"done"}]' > $MOCK_DIR/script.json; curl -s -X POST localhost:18080/reset >/dev/null
timeout 30 codex exec --json --skip-git-repo-check -C $WS --dangerously-bypass-approvals-and-sandbox 'go' </dev/null 2>&1 | grep -v "PATH aliases" | cut -c1-300; echo "files: $(ls $WS)"
python3 -I -c "import json;[print('model saw:', json.loads(l)['data'].get('lastOutput')) for l in open('$MOCK_DIR/log.jsonl') if json.loads(l)['event']=='request' and json.loads(l)['data']['step']==1]"
echo "### denied calls leave no files (deny-exit2)"
echo deny-exit2 > /tmp/hook-mode; : > /tmp/hook.log
/opt/spike/matrix.sh deny2 /opt/spike/s-matrix.json --prompt go --policy '"untrusted"' --sandbox workspace-write | tail -2
python3 -I -c "import json;[print(' step', json.loads(l)['data']['step'], (json.loads(l)['data'].get('lastOutput') or '')[:90].replace(chr(10),' ')) for l in open('$MOCK_DIR/log.jsonl') if json.loads(l)['event']=='request']"
echo "  hooked tools: $(python3 -I -c "import json;print([json.loads(l)['tool'] for l in open('/tmp/hook.log')])")"
grep -c '"server_request"' $OUT/deny2.jsonl
echo "### strict hook, harness down"
cp /opt/spike/hook-strict.py /tmp/hook-strict.py
echo "### strict hook needs a managed hooks.json pointing at it: see req2 image"
