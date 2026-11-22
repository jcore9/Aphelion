# Throwaway spike image for M0-03. Never merged.
FROM ubuntu:26.04
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 10001 harness && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin harness \
 && groupadd -g 10002 aphelion-agent && useradd -u 10002 -g 10002 -m -s /bin/bash aphelion-agent \
 && groupadd -g 10003 aphelion-secrets && useradd -u 10003 -g 10003 -M -s /usr/sbin/nologin aphelion-secrets \
 && groupadd -g 10004 aphelion-plugins && useradd -u 10004 -g 10004 -M -s /usr/sbin/nologin aphelion-plugins \
 && usermod -aG aphelion-agent harness
RUN install -d -o harness -g harness -m 0750 /etc/aphelion \
 && install -d -o harness -g harness -m 0700 /var/lib/aphelion \
 && install -d -o aphelion-agent -g aphelion-agent -m 0750 /var/lib/aphelion-agents \
 && install -d -o aphelion-secrets -g aphelion-secrets -m 0700 /var/lib/aphelion-secrets \
 && install -d -o aphelion-plugins -g aphelion-plugins -m 0700 /var/lib/aphelion-plugins \
 && install -d -m 0755 /etc/claude-code && echo '{"permissions":{"disableBypassPermissionsMode":"disable"}}' > /etc/claude-code/managed-settings.json
COPY stub /usr/local/bin/aphelion-stub
COPY launch.sh /usr/local/bin/launch.sh
