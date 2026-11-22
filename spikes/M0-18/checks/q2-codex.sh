#!/bin/bash
# Q2: Codex's own sandbox (codex sandbox) directly in the container, or inside the bot's namespaces. No login.
where=$1
root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home/.codex
env_=(HOME=$root/a/home CODEX_HOME=$root/a/home/.codex)
cmd='echo in-sandbox; touch ./in-cwd && echo WROTE-CWD; touch /var/lib/aphelion-agents/a/home/x 2>&1 && echo WROTE-HOME || echo HOME-WRITE-BLOCKED; python3 -I -c "import socket; socket.create_connection((\"1.1.1.1\",443),3); print(\"NET-OPEN\")" 2>&1 | tail -1'
run=(/opt/cli/codex/bin/codex sandbox -c sandbox_mode=workspace-write -- sh -c "$cmd")
cd $root/a/workspace
if [ $where = direct ]; then out=$(env "${env_[@]}" timeout 60 "${run[@]}" 2>&1); else out=$(/opt/spike/botwrap.sh $where a -- env "${env_[@]}" timeout 60 "${run[@]}" 2>&1); fi
echo "[codex sandbox where=$where] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-320)"
rm -rf $root/*
