#!/bin/bash
# Filesystem and proc isolation probe. No network connections.
set +e
echo "WHO $(id)"
echo "--- status ---"
grep -E '^(Name|Uid|Gid|Groups|CapEff|CapPrm|CapBnd|CapAmb|NoNewPrivs|Seccomp):' /proc/self/status
echo "--- paths ---"
for p in \
  /etc/aphelion /var/lib/aphelion /var/lib/aphelion-secrets \
  /var/lib/aphelion-agents /var/lib/aphelion-plugins \
  /etc/claude-code /etc/claude-code/managed-settings.json \
  /etc/grok /run /run/secrets /run/secrets/bootstrap \
  /home/aphelion-agent /tmp /dev/shm \
  /var/run/docker.sock /run/docker.sock /var/run/docker.sock
do
  if [ -e "$p" ] || [ -L "$p" ]; then
    stat -c 'MODE %a OWNER %u:%g %n' "$p" 2>&1
  else
    echo "ABSENT $p"
  fi
done
echo "--- access ---"
try() {
  label=$1
  shift
  if "$@" >/tmp/adv-out 2>/tmp/adv-err; then
    echo "ALLOWED $label :: $(head -c 200 /tmp/adv-out | tr '\n' ' ')"
  else
    echo "DENIED  $label :: $(head -c 200 /tmp/adv-err | tr '\n' ' ')"
  fi
}
try "list /etc/aphelion" ls -la /etc/aphelion
try "list /var/lib/aphelion" ls -la /var/lib/aphelion
try "list /var/lib/aphelion-secrets" ls -la /var/lib/aphelion-secrets
try "list /var/lib/aphelion-agents" ls -la /var/lib/aphelion-agents
try "list /var/lib/aphelion-plugins" ls -la /var/lib/aphelion-plugins
try "read managed-settings" wc -c /etc/claude-code/managed-settings.json
try "read bootstrap secret" wc -c /run/secrets/bootstrap
try "list /home/aphelion-agent" ls -la /home/aphelion-agent
try "write /etc/aphelion/pwn" touch /etc/aphelion/pwn
try "overwrite managed-settings" sh -c 'printf x >> /etc/claude-code/managed-settings.json'
try "write /var/lib/aphelion/pwn" touch /var/lib/aphelion/pwn
try "write /var/lib/aphelion-secrets/pwn" touch /var/lib/aphelion-secrets/pwn
try "write /var/lib/aphelion-agents/pwn" touch /var/lib/aphelion-agents/pwn
try "write /usr/local/bin/x" touch /usr/local/bin/x
try "write /etc/claude-code/new" touch /etc/claude-code/new
echo "--- processes ---"
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  u=$(awk '/^Uid:/ {print $2}' "$d/status" 2>/dev/null)
  n=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  echo "pid=$pid uid=$u cmd=$n"
done
echo "--- proc cross-read ---"
for d in /proc/[0-9]*; do
  pid=${d#/proc/}
  u=$(awk '/^Uid:/ {print $2}' "$d/status" 2>/dev/null)
  [ "$u" = "$(id -u)" ] && continue
  try "cmdline $pid" cat "$d/cmdline"
  try "environ $pid" wc -c "$d/environ"
  try "fd list $pid" ls -l "$d/fd"
  try "mem $pid" timeout 1 dd if="$d/mem" of=/dev/null bs=1 count=1 status=none
  if [ -e "$d/fd/0" ]; then
    try "fd0 $pid" timeout 1 wc -c "$d/fd/0"
  fi
  try "root link $pid" ls -ld "$d/root"
done
echo "--- mounts mentioning secret or docker ---"
grep -E 'secret|docker.sock|aphelion' /proc/mounts || true
echo "--- uid map ---"
cat /proc/1/uid_map 2>&1 | head -5
echo "DONE"
