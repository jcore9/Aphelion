#!/bin/bash
# Q1: can aphelion-agent, with no capabilities, create namespaces at all?
echo "== who: $(id)"; grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status | tr '\n' ' '; echo
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-220)"; }
try unshare-U         unshare -U true
try unshare-Ur-caps   unshare -Ur sh -c 'grep CapEff /proc/self/status'
try unshare-Um        unshare -Um true
try unshare-Ump-proc  unshare -Umpf --mount-proc true
try unshare-Un        unshare -Un true
try bwrap-minimal     bwrap --unshare-user --ro-bind / / true
try bwrap-pid-proc    bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc true
try bwrap-pid-noproc  bwrap --unshare-user --unshare-pid --ro-bind / / --tmpfs /proc true
try bwrap-dev         bwrap --unshare-user --ro-bind / / --dev /dev true
try bwrap-net         bwrap --unshare-user --unshare-net --ro-bind / / true
try bwrap-all-try     bwrap --unshare-all --share-net --ro-bind / / --dev /dev --tmpfs /proc true
