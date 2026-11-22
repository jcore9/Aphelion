#!/bin/bash
# Third pass: fail-closed hook, managed [rules], allowed_login_methods. Spike code. Never merged.
set -u
export BUN=/usr/local/bin/bun CODEX_HOME=/home/aphelion-agent/.codex MOCK_KEY=x WS=/home/aphelion-agent/ws OUT=/tmp/out MOCK_DIR=/tmp/mock CODEX_BIN=codex
mkdir -p $CODEX_HOME/rules $OUT $MOCK_DIR
sed -n '/^cat > \$CODEX_HOME\/config.toml/,/^CFG$/p' /opt/spike/req-test2.sh | sed '1d;$d' > $CODEX_HOME/config.toml
echo 'prefix_rule(pattern = ["cat"], decision = "allow")' > $CODEX_HOME/rules/default.rules
echo '[]' > $MOCK_DIR/script.json
setsid python3 -I /opt/spike/mock_responses.py 18080 $MOCK_DIR/script.json $MOCK_DIR/log.jsonl </dev/null >/tmp/mock.out 2>&1 &
sleep 0.7
echo "### requirements as read"
bun /opt/spike/app-server-probe.ts --cwd /tmp --requirements -- codex app-server 2>/dev/null | grep configRequirements | grep -oE '"(allowedLoginMethods|rules|execPolicy)[^]]*\]' ; bun /opt/spike/app-server-probe.ts --cwd /tmp --requirements -- codex app-server 2>/dev/null | grep configRequirements | cut -c1-200
echo "### strict hook, harness down"
: > /tmp/hook.log; /opt/spike/matrix.sh strict-down /opt/spike/s-matrix.json --prompt go --policy '"untrusted"' --sandbox workspace-write
echo "  hooked: $(wc -l < /tmp/hook.log)"
echo "### strict hook, harness answers allow"
setsid python3 -I /opt/spike/harness.py allow </dev/null >/dev/null 2>&1 & sleep 0.5
: > /tmp/hook.log; /opt/spike/matrix.sh strict-allow /opt/spike/s-matrix.json --prompt go --policy '"untrusted"' --sandbox workspace-write
echo "  hooked: $(wc -l < /tmp/hook.log)"
grep -m3 -E '"(server_request|item/started)"' $OUT/strict-allow.jsonl | cut -c1-160
