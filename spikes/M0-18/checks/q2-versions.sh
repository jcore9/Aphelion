#!/bin/bash
# Q2: each CLI binary starts inside the bot's namespaces with no login and no sandbox of its own.
where=$1; root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home; cd $root/a/workspace
w() { if [ $where = direct ]; then env HOME=$root/a/home "$@"; else /opt/spike/botwrap.sh $where a -- env HOME=$root/a/home "$@"; fi; }
for c in "/opt/cli/claude/bin/claude.exe --version" "/opt/cli/codex/bin/codex --version" "env GROK_SANDBOX=off /opt/cli/grok/bin/grok version" "/opt/cli/codex/bin/codex login status" "/opt/cli/claude/bin/claude.exe auth status"; do
  out=$(w timeout 30 $c 2>&1 </dev/null); echo "[$c where=$where] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; done
rm -rf $root/*
