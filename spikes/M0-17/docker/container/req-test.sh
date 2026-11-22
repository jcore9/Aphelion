#!/bin/bash
# Runs the M0-17 managed-config checks inside the hardened container, as aphelion-agent.
# Spike code. Never merged.
set -u
export BUN=/usr/local/bin/bun CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x WS=/home/aphelion-agent/ws OUT=/tmp/out MOCK_DIR=/tmp/mock CODEX_BIN=codex
mkdir -p $CODEX_HOME $OUT $MOCK_DIR
cat > $CODEX_HOME/config.toml <<'CFG'
model = "gpt-5.5"
model_provider = "mock"
check_for_update_on_startup = true
approval_policy = "never"
sandbox_mode = "danger-full-access"
approvals_reviewer = "auto_review"

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
cat > $CODEX_HOME/hooks.json <<'HK'
{"hooks": {"PreToolUse": [{"matcher": ".*", "hooks": [{"type": "command", "command": "echo user-hook-ran >> /tmp/user-hook.log", "timeout": 3}]}]}}
HK
mkdir -p $CODEX_HOME/rules && echo 'prefix_rule(pattern = ["cat"], decision = "allow")' > $CODEX_HOME/rules/default.rules
echo '[]' > $MOCK_DIR/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 $MOCK_DIR/script.json $MOCK_DIR/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
sleep 0.7
P="bun /opt/spike/app-server-probe.ts"
echo "### ls -l /etc/codex"; ls -ln /etc/codex
echo "### write attempt"; (echo x >> /etc/codex/requirements.toml) 2>&1
echo "### requirements + hooks/list + defaults from a user config that asks for never/full-access/auto_review"
mkdir -p $WS; cd /tmp
$P --cwd $WS --requirements --hooks --prompt 'hi' --timeout 20000 -- codex app-server 2>/dev/null | grep -E '"(configRequirements/read|hooks/list|thread/start|thread/start_error|configWarning|warning)"' | cut -c1-1200
for spec in 'policy "never"' 'policy {"granular":{"sandbox_approval":true,"rules":true,"skill_approval":true,"request_permissions":true,"mcp_elicitations":true}}' 'policy "on-request"' 'sandbox danger-full-access' 'reviewer auto_review'; do
  k=${spec%% *}; v=${spec#* }
  echo "### thread/start --$k $v"
  $P --cwd $WS --prompt 'hi' --$k "$v" --timeout 20000 -- codex app-server 2>/dev/null | grep -E '"(thread/start|thread/start_error|warning|configWarning)"' | cut -c1-400
done
echo "### turn/start override approvalPolicy never"
$P --cwd $WS --prompt 'hi' --turn-policy '"never"' --timeout 20000 -- codex app-server 2>/dev/null | grep -E '"(thread/start|turn/start_error|turn/completed|warning)"' | cut -c1-400
echo "### turn/start override sandbox dangerFullAccess"
$P --cwd $WS --prompt 'hi' --turn-sandbox '{"type":"dangerFullAccess"}' --timeout 20000 -- codex app-server 2>/dev/null | grep -E '"(turn/start_error|turn/completed|warning)"' | cut -c1-400
echo "### exec --dangerously-bypass-approvals-and-sandbox"
echo '[{"call":"exec_command","args":{"cmd":"echo bypassed > /home/aphelion-agent/ws/bypass.txt"}},{"say":"done"}]' > $MOCK_DIR/s1.json; cp $MOCK_DIR/s1.json $MOCK_DIR/script.json; curl -s -X POST localhost:18080/reset >/dev/null
timeout 30 codex exec --skip-git-repo-check -C $WS --dangerously-bypass-approvals-and-sandbox 'go' </dev/null 2>&1 | grep -vi "PATH aliases" | tail -4; ls $WS
echo "### exec -a never -s danger-full-access"
cp $MOCK_DIR/s1.json $MOCK_DIR/script.json; curl -s -X POST localhost:18080/reset >/dev/null
timeout 30 codex exec --skip-git-repo-check -C $WS -c approval_policy='"never"' -s danger-full-access 'go' </dev/null 2>&1 | grep -vi "PATH aliases" | tail -4; ls $WS
for mode in allow deny-exit2 deny-json crash-exit1 garbage sleep harness; do
  echo $mode > /tmp/hook-mode; : > /tmp/hook.log; : > /tmp/user-hook.log
  /opt/spike/matrix.sh "hook-$mode" /opt/spike/s-matrix.json --prompt go --policy '"untrusted"' --sandbox workspace-write | grep -v files:
  echo "  hook log: $(wc -l < /tmp/hook.log) calls: $(cut -c1-60 /tmp/hook.log | tr '\n' ' ' | cut -c1-500)"
  echo "  user hook log lines: $(wc -l < /tmp/user-hook.log)"
done
