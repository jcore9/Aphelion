# Throwaway spike image for M0-18. Never merged.
FROM ubuntu:26.04
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat python3 curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10000 -M -d /nonexistent -s /usr/sbin/nologin harness \
 && useradd -u 10001 -M -d /var/lib/aphelion-agents -s /bin/bash aphelion-agent \
 && mkdir -p /var/lib/aphelion-agents && chown 10001:10001 /var/lib/aphelion-agents && chmod 750 /var/lib/aphelion-agents
