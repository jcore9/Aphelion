#!/bin/bash
# Q5: does a bot see only its own folder, and can it reach another bot through /proc or signals?
mode=$1
root=/var/lib/aphelion-agents; W=/opt/spike/botwrap.sh
for b in a b mgr; do mkdir -p $root/$b/workspace $root/$b/home; echo "secret-of-$b" > $root/$b/workspace/secret; done
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-240)"; }
echo "== proc mode: $mode"
$W $mode b -- sh -c 'echo $$ > /tmp/x; exec sleep 300' & BPID=$!
sleep 1
BCHILD=$(pgrep -f 'sleep 300' | head -1)
echo "runner sees bot b's sleep as container pid $BCHILD"
try a-ls-root      $W $mode a -- ls $root
try a-read-own     $W $mode a -- cat $root/a/workspace/secret
try a-read-b       $W $mode a -- cat $root/b/workspace/secret
try a-caps         $W $mode a -- sh -c 'grep -E "^(CapEff|NoNewPrivs)" /proc/self/status 2>&1 | tr "\n" " "; id'
try a-ps-count     $W $mode a -- sh -c 'ls /proc | grep -c "^[0-9]"'
try a-via-proc-root $W $mode a -- cat /proc/$BCHILD/root$root/b/workspace/secret
try a-via-proc-environ $W $mode a -- sh -c "tr '\0' ' ' < /proc/$BCHILD/environ | cut -c1-80"
try a-kill-b-pid   $W $mode a -- kill -0 $BCHILD
try a-pidfd-signal-b $W $mode a -- sh -c "python3 -I -c \"import os,signal;fd=os.open('/proc/$BCHILD',os.O_RDONLY|os.O_DIRECTORY);signal.pidfd_send_signal(fd,0);print('signal 0 delivered to bot b')\" 2>&1 | tail -1"
try a-see-server   $W $mode a -- sh -c 'ls -d /proc/1/root/etc 2>&1; cat /proc/1/cmdline 2>&1 | tr "\0" " "'
try mgr-granted-b  $W $mode mgr b -- sh -c "ls $root; cat $root/b/workspace/secret; echo mgr-was-here > $root/b/workspace/from-mgr && echo wrote"
try mgr-read-a     $W $mode mgr b -- cat $root/a/workspace/secret
try a-abstract-sock $W $mode a -- python3 -I -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('\0m018-probe');print('abstract socket bound in shared netns')"
try a-nested-userns $W $mode a -- unshare -Ur true
try a-umount-escape $W $mode a -- unshare -Urm sh -c "umount -l $root/a 2>&1; ls $root 2>&1; ls / | tr '\n' ' '"
kill $BPID; wait $BPID 2>/dev/null
rm -rf $root/*
