#!/bin/bash
# Q2: egress from inside the bot's namespaces on a Docker --internal network, where the only way out is the CONNECT proxy.
root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home/.codex; cd $root/a/workspace
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; }
W="/opt/spike/botwrap.sh fresh a --"
echo "env inside the bot: $($W env | grep -i -E '^(https?_proxy|no_proxy)=' | tr '\n' ' ')"
try curl-via-proxy  $W curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://example.com
try curl-direct     $W curl -sS -o /dev/null -w '%{http_code}' --max-time 5 --noproxy '*' https://example.com
try claude-via-proxy $W env ANTHROPIC_API_KEY=sk-dummy ANTHROPIC_BASE_URL=https://example.com CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 timeout 40 /opt/cli/claude/bin/claude.exe -p hi --max-turns 1
try codex-via-proxy $W env CODEX_HOME=$root/a/home/.codex MOCK_KEY=dummy timeout 40 /opt/cli/codex/bin/codex exec --skip-git-repo-check -c 'model_provider="m"' -c 'model_providers.m={name="m",base_url="https://example.com/v1",env_key="MOCK_KEY",wire_api="responses"}' -c check_for_update_on_startup=false hi
try grok-via-proxy  $W env XAI_API_KEY=dummy GROK_XAI_API_BASE_URL=https://example.com GROK_SANDBOX=off GROK_AUTO_UPDATE=0 timeout 40 /opt/cli/grok/bin/grok -p hi
rm -rf $root/*
