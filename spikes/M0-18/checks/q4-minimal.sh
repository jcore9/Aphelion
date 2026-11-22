#!/bin/bash
# Q4: which namespace calls does the bot sandbox need? Run with each profile variant.
root=/var/lib/aphelion-agents; mkdir -p $root/a/workspace $root/a/home
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"; }
try botwrap-sharedrw /opt/spike/botwrap.sh sharedrw a -- true
try botwrap-shared-netns-off /opt/spike/botwrap.sh sharedrw a -- sh -c 'true' 
try bwrap-unshare-net bwrap --unshare-user --unshare-net --ro-bind / / true
try nested-bwrap /opt/spike/botwrap.sh sharedrw a -- bwrap --unshare-user --unshare-pid --ro-bind / / --dev /dev --tmpfs /proc true
rm -rf $root/*
