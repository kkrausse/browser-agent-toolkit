# One image for every service in compose.yaml: the mock model server, a pinned
# opencode, a pinned codex and the two small proxies. Nothing is taken from the
# host's opencode/codex installs; the packages are downloaded at build time,
# which is the only moment this setup uses the internet.
FROM oven/bun:1.4.0-debian

ARG OPENCODE_VERSION=2.0.26
ARG CODEX_VERSION=0.162.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bubblewrap ca-certificates procps curl nginx-light openssl \
 && rm -rf /var/lib/apt/lists/*

# The platform packages hold the native binaries; the wrapper packages only add
# a node launcher/postinstall, so scripts are skipped and the binaries linked directly.
RUN mkdir -p /opt/tools && cd /opt/tools \
 && printf '{"name":"tools","private":true}\n' > package.json \
 && bun add --ignore-scripts --exact \
      "@opencode/cli-linux-x64@${OPENCODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && ln -s /opt/tools/node_modules/@opencode/cli-linux-x64/bin/opencode /usr/local/bin/opencode \
 && CODEX_BIN="$(find /opt/tools/node_modules -type f -path '*/vendor/*/bin/codex' | head -1)" \
 && test -n "$CODEX_BIN" && ln -s "$CODEX_BIN" /usr/local/bin/codex \
 && rm -rf /root/.bun/install/cache \
 && opencode --version && codex --version

# Same uid as the image's stock `bun` user would be fine; a dedicated one keeps
# the homes obvious. Tools run as this user, never root.
RUN useradd --create-home --uid 1100 --shell /bin/bash agent \
 && install -d -o agent -g agent /tmp/wasm-term-workspace
COPY --chown=agent:agent server.ts tap-proxy.ts opencode.config.json codex.config.toml /opt/mock-llm/
COPY --chown=agent:agent docker/tcp-forward.ts docker/entrypoint.sh docker/tls-front.sh /opt/mock-llm/
RUN chmod +x /opt/mock-llm/entrypoint.sh

USER agent
ENV HOME=/home/agent \
    OPENCODE_DISABLE_AUTOUPDATE=1 \
    OPENCODE_DISABLE_MODELS_FETCH=1
WORKDIR /home/agent
ENTRYPOINT ["/opt/mock-llm/entrypoint.sh"]
