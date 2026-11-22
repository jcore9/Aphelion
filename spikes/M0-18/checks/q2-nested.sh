#!/bin/bash
# Q2: can a sandbox (bwrap) start inside the bot's namespaces?
mode=$1; root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; }
W="/opt/spike/botwrap.sh $mode a --"
try nested-bwrap-noproc $W bwrap --unshare-user --unshare-pid --ro-bind / / --dev /dev --tmpfs /proc true
try nested-bwrap-proc   $W bwrap --unshare-user --unshare-pid --ro-bind / / --dev /dev --proc /proc true
try nested-bwrap-net    $W bwrap --unshare-user --unshare-net --ro-bind / / --dev /dev true
try nested-bwrap-claude-style $W bwrap --new-session --die-with-parent --unshare-pid --unshare-net --ro-bind / / --dev /dev --proc /proc --bind $root/a/workspace $root/a/workspace true
rm -rf $root/*
