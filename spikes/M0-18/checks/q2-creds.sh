#!/bin/bash
# Q2: a shared login file bind-mounted into a bot's home. Dummy files only, never a real login.
root=/var/lib/aphelion-agents; shared=$root/.shared-logins
mkdir -p $root/a/workspace $root/a/home/.codex $root/b/workspace $root/b/home $shared/codex
echo '{"dummy":"m018-not-a-credential","v":1}' > $shared/codex/auth.json
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; }
W=/opt/spike/botwrap.sh
FILE=(--bind $shared/codex/auth.json $root/a/home/.codex/auth.json)
DIR=(--bind $shared/codex $root/a/home/.codex)
bw() { local extra=("${!1}"); shift; bwrap --unshare-user --unshare-pid --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind /etc /etc --dev /dev --tmpfs /tmp --proc /proc --dir $root --bind $root/a $root/a "${extra[@]}" --setenv HOME $root/a/home --chdir $root/a/workspace -- "$@"; }
f=$root/a/home/.codex/auth.json
try file-read          bw FILE[@] cat $f
try file-write-inplace bw FILE[@] sh -c "echo '{\"dummy\":\"m018\",\"v\":2}' > $f && cat $f"
try file-rename-over   bw FILE[@] sh -c "echo '{\"v\":3}' > $f.tmp && mv -f $f.tmp $f"
try file-rename-python bw FILE[@] python3 -I -c "import os;open('$f.tmp','w').write('{\"v\":3}');os.replace('$f.tmp','$f')"
try file-unlink        bw FILE[@] rm -f $f
try dir-rename-over    bw DIR[@] sh -c "echo '{\"v\":4}' > $f.tmp && mv -f $f.tmp $f && cat $f"
try dir-lock           bw DIR[@] python3 -I -c "import fcntl;fd=open('$f');fcntl.flock(fd,fcntl.LOCK_EX);print('flock ok')"
echo "outside after the bot ran: $(cat $shared/codex/auth.json)  owner=$(stat -c %u:%g $shared/codex/auth.json)"
try bot-b-sees-shared $W fresh b -- ls -a $root
rm -rf $root/* $root/.shared-logins
