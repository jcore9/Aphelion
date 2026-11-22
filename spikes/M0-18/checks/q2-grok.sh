#!/bin/bash
# Q2: Grok Build inside the bot's namespaces, no login: version, doctor and inspect with a sandbox profile, and the Landlock ABI.
where=$1
root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home; cd $root/a/workspace
env_=(HOME=$root/a/home GROK_SANDBOX=strict GROK_AUTO_UPDATE=0 TERM=dumb)
ll='import ctypes;l=ctypes.CDLL(None,use_errno=True);r=l.syscall(444,None,0,1);print("landlock ABI",r,"errno",ctypes.get_errno())'
w() { if [ $where = direct ]; then env "${env_[@]}" "$@"; else /opt/spike/botwrap.sh $where a -- env "${env_[@]}" "$@"; fi; }
for c in "version" "doctor" "inspect"; do out=$(w timeout 30 /opt/cli/grok/bin/grok $c 2>&1 </dev/null); echo "[grok $c where=$where] exit=$? :: $(echo "$out" | grep -i -E "sandbox|landlock|bwrap|version|grok [0-9]|error" | tr '\n' ' ' | cut -c1-400)"; done
echo "[landlock where=$where] $(w python3 -I -c "$ll" 2>&1)"
rm -rf $root/*
