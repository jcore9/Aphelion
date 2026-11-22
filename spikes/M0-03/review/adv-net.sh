#!/bin/bash
# One TCP connect per target, no payload. Do not re-run.
set +e
echo "=== route ==="
cat /proc/net/route
echo "=== resolv ==="
cat /etc/resolv.conf
echo "=== connect ==="
try() {
  h=$1
  p=$2
  timeout 3 bash -c "exec 3<>/dev/tcp/${h}/${p}"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "CONNECT_OK ${h}:${p}"
  else
    echo "CONNECT_FAIL ${h}:${p} rc=${rc}"
  fi
}
try 10.0.0.1 80
try 10.0.0.133 22
try 100.71.226.67 22
try 100.93.139.95 22
try 172.17.0.1 22
try 1.1.1.1 443
echo "=== docker sock ==="
ls -l /var/run/docker.sock /run/docker.sock 2>&1
echo DONE
