#!/bin/sh
# Variant A init: tini runs this as PID 1's child; setpriv drops to each user.
set -e
drop() { u=$1; shift; setpriv --reuid="$u" --regid="$u" --init-groups --inh-caps=-all -- "$@" & }
drop harness          /usr/local/bin/aphelion-stub server server
# The redirect must sit on the backgrounded command itself, or sh gives it /dev/null.
setpriv --reuid=aphelion-secrets --regid=aphelion-secrets --init-groups --inh-caps=-all -- /usr/local/bin/aphelion-stub broker broker < /run/secrets/bootstrap &
drop aphelion-agent   /usr/local/bin/aphelion-stub idle agent-runner
drop aphelion-plugins /usr/local/bin/aphelion-stub idle plugin-runner
echo "launcher (setpriv) started 4 children as uid $(id -u)"
wait
