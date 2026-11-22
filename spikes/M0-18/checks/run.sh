#!/bin/bash
# run.sh <seccomp: default|unconfined|<name>> <script in checks/> [extra docker run args...] -- [script args]
# Starts the 0016-hardened container as root with only SETUID and SETGID, then drops to aphelion-agent (10001),
# the way the init starts the agent runner.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
prof=$1; script=$2; shift 2
extra=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do extra+=("$1"); shift; done; [ "${1:-}" = "--" ] && shift
case $prof in
  default) sec=() ;;
  unconfined) sec=(--security-opt seccomp=unconfined) ;;
  *) sec=(--security-opt "seccomp=$here/seccomp/$prof.json") ;;
esac
exec timeout -k 10 300 sg docker -c "$(printf '%q ' docker run --rm --name m018-run \
  --read-only --cap-drop ALL --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges:true "${sec[@]}" --pids-limit 512 --memory 1g \
  --tmpfs /tmp:mode=1777 -v m018-agents:/var/lib/aphelion-agents \
  -v "$here/checks:/opt/spike:ro" "${extra[@]}" \
  aphelion-m018:base setpriv --reuid 10001 --regid 10001 --clear-groups -- bash "/opt/spike/$script" "$@")"
