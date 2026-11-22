#!/bin/bash
# Q6 baseline: decision 0016 cancels a bot by killing its process group. No namespaces.
mkdir -p /tmp/t; cat > /tmp/t/tree.sh <<'T'
sleep 1001 &
setsid sh -c 'sleep 1002 & exec sleep 1003' &
nohup sleep 1004 >/dev/null 2>&1 &
exec sleep 1005
T
setsid sh /tmp/t/tree.sh & p=$!; sleep 1; b=$(pgrep -c -x sleep); kill -KILL -- -$p; sleep 1
echo "[no namespaces, SIGKILL to the process group] sleeps before=$b after=$(pgrep -c -x sleep)"; pkill -KILL -x sleep
