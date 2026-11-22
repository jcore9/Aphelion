#!/bin/bash
# Which hosts Codex contacts, and whether it uses HTTPS_PROXY. No login. Spike code. Never merged.
set -u
export CODEX_HOME=/home/aphelion-agent/.codex; mkdir -p $CODEX_HOME /home/aphelion-agent/ws
echo "### direct egress is blocked:"; curl -s -m 5 -o /dev/null -w '%{http_code}\n' --noproxy '*' https://api.openai.com/ || echo "direct curl failed (expected)"
echo "### app-server: initialize, account/read, rateLimits, model/list (no login)"
cd /opt/spike && timeout 60 bun app-server-probe.ts --cwd /home/aphelion-agent/ws --account -- codex app-server 2>&1 | grep -E 'account/read|rateLimits/read|initialize"|stderr' | cut -c1-300
echo "### exec with a dummy API key (expect 401 from OpenAI, through the proxy)"
OPENAI_API_KEY=sk-dummy-not-a-real-key timeout 60 codex exec --json --skip-git-repo-check -C /home/aphelion-agent/ws 'say ok' </dev/null 2>&1 | grep -v "PATH aliases" | cut -c1-300 | tail -8
