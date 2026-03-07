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
        npm install -g openclaw@2026.3.2 @googleworkspace/cli && exit 0; \
        echo "npm install failed on attempt ${attempt}, retrying..." >&2; \
        sleep $((attempt * 10)); \
      done; \
      exit 1
RUN rm -f /usr/local/bin/gog && rm -rf /usr/local/lib/node_modules/openclaw/skills/gog

WORKDIR /app

RUN mkdir -p /opt/pinai/plugins/telegram-router-proxy
COPY openclaw-plugins/telegram-router-proxy/ /opt/pinai/plugins/telegram-router-proxy/
COPY infra/container-manager/images/openclaw/skills/ /usr/local/lib/node_modules/openclaw/skills/

# ── Warm up jiti + Node compile caches at build time ──
# Launch gateway with --allow-unconfigured so it fully boots (compiles all TS
# modules via jiti) without requiring real Telegram/model credentials.
# After 60s the gateway is killed; caches are saved into /opt/*-warmup/.
RUN mkdir -p /tmp/jiti \
    && NODE_COMPILE_CACHE=/tmp/node-compile-cache \
       timeout 60 openclaw gateway --bind loopback --allow-unconfigured 2>&1 || true \
    && mkdir -p /opt/jiti-warmup /opt/node-compile-warmup \
    && cp -r /tmp/jiti/. /opt/jiti-warmup/ 2>/dev/null || true \
    && cp -r /tmp/node-compile-cache/. /opt/node-compile-warmup/ 2>/dev/null || true \
    && rm -rf /tmp/jiti /tmp/node-compile-cache /root/.openclaw

VOLUME /app/config
VOLUME /app/data

ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENCLAW_TELEGRAM_ROUTER_PLUGIN_PATH="/opt/pinai/plugins/telegram-router-proxy"

EXPOSE 18789

CMD ["openclaw", "gateway", "--bind", "lan"]
