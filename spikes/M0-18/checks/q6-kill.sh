#!/bin/bash
# Q6: does killing the bot's bwrap take its whole process tree, including a daemon that left its process group?
# The tree: a background sleep, a setsid daemon with its own child, a nohup sleep, and the main sleep. Five sleeps.
mode=$1; root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home
cat > $root/a/workspace/tree.sh <<'T'
sleep 1001 &
setsid sh -c 'sleep 1002 & exec sleep 1003' &
nohup sleep 1004 >/dev/null 2>&1 &
exec sleep 1005
T
count() { pgrep -c -x sleep; }
W=/opt/spike/botwrap.sh
raw="bwrap --unshare-user --ro-bind / / --dev /dev --bind $root/a $root/a"
run() { local label=$1; shift
  "$@" sh $root/a/workspace/tree.sh & local p=$!; sleep 1
  local b=$(count); kill -KILL $p; wait $p 2>/dev/null; sleep 1
  echo "[$label] sleeps before=$b, after SIGKILL of the started process=$(count)"; pkill -KILL -x sleep; sleep 0.3; }
run "plain child, no namespaces" env
run "bwrap, pid namespace, --die-with-parent (botwrap.sh)" $W $mode a --
run "bwrap, pid namespace, no --die-with-parent" $raw --unshare-pid --
run "bwrap, no pid namespace, --die-with-parent" $raw --die-with-parent --
run "bwrap, no pid namespace, no --die-with-parent" $raw --
sh -c "$W $mode a -- sh $root/a/workspace/tree.sh; true" & p=$!; sleep 1; b=$(count); kill -KILL $p; sleep 1
echo "[the runner (a shell that started botwrap.sh) is killed] sleeps before=$b after=$(count)"; pkill -KILL -x sleep; sleep 0.3
setsid $W $mode a -- sh $root/a/workspace/tree.sh & p=$!; sleep 1; b=$(count); kill -KILL -- -$p; sleep 1
echo "[SIGKILL to bwrap's process group] sleeps before=$b after=$(count)"; pkill -KILL -x sleep
rm -rf $root/*
