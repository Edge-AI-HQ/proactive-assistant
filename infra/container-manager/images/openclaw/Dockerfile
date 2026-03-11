FROM node:22-slim

# Install basic dependencies
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    cmake \
    build-essential \
    wget \
    curl \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set registry https://registry.npmmirror.com \
    && for attempt in 1 2 3 4 5; do \
        npm install -g openclaw@2026.3.8 @googleworkspace/cli && exit 0; \
        echo "npm install failed on attempt ${attempt}, retrying..." >&2; \
        sleep $((attempt * 10)); \
      done; \
      exit 1
RUN rm -f /usr/local/bin/gog && rm -rf /usr/local/lib/node_modules/openclaw/skills/gog

WORKDIR /app

RUN mkdir -p /opt/pinai/plugins/telegram-router-proxy
COPY openclaw-plugins/telegram-router-proxy/ /opt/pinai/plugins/telegram-router-proxy/

# Copy custom skills: first remove any same-named bundled skills so ours
# completely replace them (no leftover files), then copy in.
COPY infra/container-manager/images/openclaw/skills/ /tmp/pinai-skills/
RUN for skill in /tmp/pinai-skills/*/; do \
      name=$(basename "$skill"); \
      rm -rf "/usr/local/lib/node_modules/openclaw/skills/$name"; \
    done \
    && cp -r /tmp/pinai-skills/. /usr/local/lib/node_modules/openclaw/skills/ \
    && rm -rf /tmp/pinai-skills

# ── Warm up jiti + Node compile caches at build time ──
# Launch gateway with plugin path so jiti compiles both openclaw core AND our
# plugin TS. After 90s the gateway is killed; caches are saved into /opt/pinai/*.
# The workspace created during warmup is preserved as a pre-built snapshot so
# cold-start containers can skip the expensive workspace-init step.
RUN mkdir -p /tmp/jiti \
    && OPENCLAW_HOME=/app \
       NODE_COMPILE_CACHE=/tmp/node-compile-cache \
       OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH=/opt/pinai/plugins/telegram-router-proxy \
       timeout 90 openclaw gateway --bind loopback --allow-unconfigured 2>&1 || true \
    && mkdir -p /opt/pinai/jiti-warmup /opt/pinai/node-compile-warmup \
    && cp -r /tmp/jiti/. /opt/pinai/jiti-warmup/ 2>/dev/null || true \
    && cp -r /tmp/node-compile-cache/. /opt/pinai/node-compile-warmup/ 2>/dev/null || true \
    && if [ -f /app/.openclaw/workspace/TOOLS.md ]; then \
         mkdir -p /opt/pinai/workspace-snapshot \
         && cp -r /app/.openclaw/workspace/. /opt/pinai/workspace-snapshot/; \
       fi \
    && rm -rf /tmp/jiti /tmp/node-compile-cache /app/.openclaw

COPY infra/container-manager/images/openclaw/pinai-entrypoint.sh /usr/local/bin/pinai-entrypoint.sh
RUN chmod +x /usr/local/bin/pinai-entrypoint.sh
COPY infra/container-manager/images/openclaw/TOOLS_to_append.md /opt/pinai/TOOLS_to_append.md

ENV OPENCLAW_HOME="/app"
ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH="/opt/pinai/plugins/telegram-router-proxy"
ENV PINAI_TOOLS_APPEND_PATH="/opt/pinai/TOOLS_to_append.md"

EXPOSE 18789

CMD ["pinai-entrypoint.sh"]
