#!/bin/bash
# Q2: Codex rewriting a shared auth.json through a bind mount. The "key" is a dummy string, never a real login.
root=/var/lib/aphelion-agents; logins=$root/.shared-logins/codex
try() { local label=$1; shift; out=$("$@" 2>&1); echo "[$label] exit=$? :: $(echo "$out" | tr '\n' ' ' | cut -c1-220)"; }
setup() { rm -rf $root/a $root/.shared-logins; mkdir -p $root/a/workspace $root/a/home/.codex $logins; echo '{"OPENAI_API_KEY":"sk-old-dummy","auth_mode":"apikey"}' > $logins/auth.json; }
bw() { local extra=("${!1}"); shift; bwrap --unshare-user --unshare-pid --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind /etc /etc --ro-bind /opt /opt --dev /dev --tmpfs /tmp --proc /proc --dir $root --bind $root/a $root/a "${extra[@]}" --setenv HOME $root/a/home --setenv CODEX_HOME $root/a/home/.codex --chdir $root/a/workspace -- "$@"; }
login='printf sk-m018-dummy-not-a-key | /opt/cli/codex/bin/codex login --with-api-key'
setup; FILE=(--bind $logins/auth.json $root/a/home/.codex/auth.json)
try single-file-bind bw FILE[@] sh -c "$login"; echo "    shared file now: $(cat $logins/auth.json | tr -d '\n' | cut -c1-90)"
setup; ln -s $logins/auth.json $root/a/home/.codex/auth.json; LINK=(--bind $logins $logins)
try symlink-to-bound-folder bw LINK[@] sh -c "$login && ls -la \$CODEX_HOME/auth.json | cut -c1-120"; echo "    shared file now: $(cat $logins/auth.json | tr -d '\n' | cut -c1-90); folder: $(ls -A $logins | tr '\n' ' ')"
rm -rf $root/a $root/.shared-logins
