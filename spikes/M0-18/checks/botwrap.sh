#!/bin/bash
# botwrap.sh <proc-mode: fresh|shared|sharedrw|nopid|none> <bot> [granted folder...] -- cmd...
# What the agent runner would run to start one bot in its own namespaces.
mode=$1 bot=$2; shift 2
root=/var/lib/aphelion-agents
grants=(); while [ $# -gt 0 ] && [ "$1" != "--" ]; do grants+=(--bind "$root/$1" "$root/$1"); shift; done; shift
pidns=(--unshare-pid)
case $mode in nopid) pidns=(); proc=(--bind /proc /proc) ;; fresh) proc=(--proc /proc) ;; shared) proc=(--ro-bind /proc /proc) ;; sharedrw) proc=(--bind /proc /proc) ;; none) proc=(--tmpfs /proc) ;; esac
exec bwrap --unshare-user "${pidns[@]}" --unshare-ipc --unshare-uts --unshare-cgroup-try \
  --die-with-parent --new-session \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin \
  --ro-bind /etc /etc --ro-bind-try /opt /opt --dev /dev --tmpfs /tmp "${proc[@]}" \
  --dir "$root" --bind "$root/$bot" "$root/$bot" "${grants[@]}" \
  --setenv HOME "$root/$bot/home" --chdir "$root/$bot/workspace" -- "$@"
