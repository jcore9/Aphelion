#!/bin/bash
# Q2: Claude Code inside the bot's namespaces, with its own bwrap sandbox on, against the mock API.
# where: direct (no bot namespace) | <botwrap mode>. weak: 0|1 (sandbox.enableWeakerNestedSandbox)
where=$1 weak=$2
root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home/.claude
cat > $root/a/home/.claude/settings.json <<J
{"sandbox": {"enabled": true, "failIfUnavailable": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false, "enableWeakerNestedSandbox": $([ $weak = 1 ] && echo true || echo false)}}
J
cmd='echo in-sandbox pid1=$(tr "\0" " " </proc/1/cmdline | cut -c1-40); touch /var/lib/aphelion-agents/a/home/outside-cwd && echo WROTE-HOME || echo HOME-WRITE-BLOCKED; touch ./in-cwd && echo WROTE-CWD'
python3 -I /opt/spike/mock_anthropic.py 18081 "$cmd" /tmp/mock.jsonl & M=$!; sleep 0.5
env_=(HOME=$root/a/home ANTHROPIC_API_KEY=sk-dummy-m018 ANTHROPIC_BASE_URL=http://127.0.0.1:18081 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1)
run=(/opt/cli/claude/bin/claude.exe -p go --output-format json --allowedTools Bash)
cd $root/a/workspace
if [ $where = direct ]; then out=$(env "${env_[@]}" timeout 90 "${run[@]}" 2>&1); else out=$(/opt/spike/botwrap.sh $where a -- env "${env_[@]}" timeout 90 "${run[@]}" 2>&1); fi
echo "[claude where=$where weak=$weak] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-300)"
python3 -I -c "
import json
for l in open('/tmp/mock.jsonl'):
    r=json.loads(l)
    if r['tool_result']: print('  tool_result:', json.dumps(r['tool_result'])[:400])
" 2>/dev/null
kill $M; rm -rf $root/* /tmp/mock.jsonl
