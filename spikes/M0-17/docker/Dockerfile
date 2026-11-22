# Throwaway spike image for M0-17. Never merged.
FROM ubuntu:26.04
ARG WITH_BWRAP=0
RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates tini \
 && if [ "$WITH_BWRAP" = 1 ]; then apt-get install -y --no-install-recommends bubblewrap; fi \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -u 10001 -m -d /home/aphelion-agent -s /bin/bash aphelion-agent
COPY codex-0169 /usr/local/lib/codex
RUN ln -s /usr/local/lib/codex/bin/codex /usr/local/bin/codex
COPY bun /usr/local/bin/bun
COPY opt-spike /opt/spike
RUN chmod -R a+rX /opt/spike /usr/local/lib/codex && chmod 755 /usr/local/bin/bun /opt/spike/matrix.sh && mkdir -p /etc/codex
USER 10001
WORKDIR /home/aphelion-agent
