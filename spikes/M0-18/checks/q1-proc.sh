#!/bin/bash
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-200)"; }
echo "masked /proc paths seen by the container:"; grep -E ' /proc/' /proc/self/mountinfo | awk '{print $5, $9}' | tr '\n' ';' | cut -c1-600; echo
try bwrap-pid-proc bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc sh -c 'ls /proc | grep -c "^[0-9]"'
