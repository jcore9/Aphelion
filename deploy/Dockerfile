FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --omit=optional --filter @aphelion/server --filter @aphelion/claude-adapter \
 && cd apps/server \
 && bun run build \
 && bun run build:broker \
 && bun run build:plugin-runner \
 && bun build --target=bun src/bots/runner-main.ts --outfile dist/bot-runner.js \
 && bun build --target=bun src/adapters/adapter-launcher.ts --outfile dist/adapter-launcher.js \
 && cd ../../packages/claude-adapter \
 && bun run build

FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db
RUN apt-get update \
 && apt-get install --yes --no-install-recommends ca-certificates git tini \
 && rm -rf /var/lib/apt/lists/* \
 && userdel --remove ubuntu \
 && groupadd --gid 10001 harness \
 && groupadd --gid 10002 aphelion-bot \
 && groupadd --gid 10003 aphelion-secrets \
 && groupadd --gid 10004 aphelion-plugins \
 && useradd --uid 10001 --gid harness --groups aphelion-bot --no-create-home --home-dir /var/lib/aphelion --shell /usr/sbin/nologin harness \
 && useradd --uid 10002 --gid aphelion-bot --no-create-home --home-dir /var/lib/aphelion-bots --shell /usr/sbin/nologin aphelion-bot \
 && useradd --uid 10003 --gid aphelion-secrets --no-create-home --home-dir /var/lib/aphelion-secrets --shell /usr/sbin/nologin aphelion-secrets \
 && useradd --uid 10004 --gid aphelion-plugins --no-create-home --home-dir /var/lib/aphelion-plugins --shell /usr/sbin/nologin aphelion-plugins \
 && install -d -o harness -g harness -m 0750 /etc/aphelion \
 && install -d -o harness -g harness -m 0700 /var/lib/aphelion \
 && install -d -o aphelion-bot -g aphelion-bot -m 0750 /var/lib/aphelion-bots \
 && install -d -o aphelion-secrets -g aphelion-secrets -m 0700 /var/lib/aphelion-secrets \
 && install -d -o aphelion-plugins -g aphelion-plugins -m 0700 /var/lib/aphelion-plugins \
 && install -d -o harness -g harness -m 0755 /opt/aphelion/plugins \
 && install -d -o harness -g harness -m 0755 /opt/aphelion/tools \
 && install -d -m 0755 /usr/local/lib/aphelion /etc/codex \
 && printf 'check_for_update_on_startup = false\n' >/etc/codex/requirements.toml \
 && for tool in claude grok opencode; do ln -s "/opt/aphelion/tools/$tool/current/$tool" "/usr/local/bin/$tool"; done \
 && ln -s "/opt/aphelion/tools/codex/current/codex-$(uname -m)-unknown-linux-musl" /usr/local/bin/codex \
 && install -d -m 0755 /usr/local/lib/aphelion/adapters/claude \
 && find / -xdev -type f -perm /6000 -exec chmod ug-s {} +
COPY --from=build --chmod=0711 /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build --chmod=0755 /src/apps/server/dist/aphelion /src/apps/server/dist/aphelion-secrets /usr/local/bin/
COPY --from=build --chmod=0644 /src/apps/server/dist/plugin-runner.js /src/apps/server/dist/bot-runner.js /src/apps/server/dist/adapter-launcher.js /usr/local/lib/aphelion/
COPY --chmod=0644 deploy/ai-tools.json /usr/local/lib/aphelion/ai-tools.json
COPY --from=build --chmod=0644 /src/packages/claude-adapter/dist/adapter.js /src/packages/claude-adapter/dist/aphelion-plugin.json /usr/local/lib/aphelion/adapters/claude/
COPY --chown=harness:harness --chmod=0640 docs/reference/config/example/*.yaml /etc/aphelion/
COPY --chmod=0755 deploy/image/launch /usr/local/lib/aphelion/launch
ENV DISABLE_AUTOUPDATER=1
EXPOSE 7400
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/lib/aphelion/launch"]
