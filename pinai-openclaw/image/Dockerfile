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

# Copy all three plugins into separate directories
RUN mkdir -p /opt/pinai/plugins/telegram-api-proxy \
             /opt/pinai/plugins/litellm-vision-adapter \
             /opt/pinai/plugins/platform-hooks
COPY pinai-openclaw/plugins/telegram-api-proxy/  /opt/pinai/plugins/telegram-api-proxy/
COPY pinai-openclaw/plugins/litellm-vision-adapter/ /opt/pinai/plugins/litellm-vision-adapter/
COPY pinai-openclaw/plugins/platform-hooks/      /opt/pinai/plugins/platform-hooks/

# Copy custom skills: first remove any same-named bundled skills so ours
# completely replace them (no leftover files), then copy in.
COPY pinai-openclaw/image/skills/ /tmp/pinai-skills/
RUN for skill in /tmp/pinai-skills/*/; do \
      name=$(basename "$skill"); \
      rm -rf "/usr/local/lib/node_modules/openclaw/skills/$name"; \
    done \
    && cp -r /tmp/pinai-skills/. /usr/local/lib/node_modules/openclaw/skills/ \
    && rm -rf /tmp/pinai-skills

# ── Warm up jiti + Node compile caches at build time ──
# Launch gateway with a near-production config so V8 compiles bytecode for
# the full module graph (channels, models, tools, skills, browser, cron).
# Without config, --allow-unconfigured only loads gateway core (~52s cold
# start on 1-CPU machines due to V8 parsing 759 JS files from scratch).
COPY pinai-openclaw/image/warmup-config.json /tmp/warmup-config.json
RUN mkdir -p /tmp/jiti /app/.openclaw \
    && cp /tmp/warmup-config.json /app/.openclaw/openclaw.json \
    && OPENCLAW_HOME=/app \
       NODE_COMPILE_CACHE=/tmp/node-compile-cache \
       OPENCLAW_PLUGIN_LOAD_PATHS=/opt/pinai/plugins/telegram-api-proxy:/opt/pinai/plugins/litellm-vision-adapter:/opt/pinai/plugins/platform-hooks \
       timeout 120 openclaw gateway --bind loopback 2>&1 || true \
    && mkdir -p /opt/pinai/jiti-warmup /opt/pinai/node-compile-warmup \
    && cp -r /tmp/jiti/. /opt/pinai/jiti-warmup/ 2>/dev/null || true \
    && cp -r /tmp/node-compile-cache/. /opt/pinai/node-compile-warmup/ 2>/dev/null || true \
    && rm -rf /tmp/jiti /tmp/node-compile-cache /app/.openclaw /tmp/warmup-config.json

COPY pinai-openclaw/image/scripts/ /opt/pinai/scripts/
COPY pinai-openclaw/image/pinai-entrypoint.sh /usr/local/bin/pinai-entrypoint.sh
RUN chmod +x /usr/local/bin/pinai-entrypoint.sh
COPY pinai-openclaw/image/platform-system-guidance.md /opt/pinai/platform-system-guidance.md

ENV OPENCLAW_HOME="/app"
ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENCLAW_PLUGIN_LOAD_PATHS="/opt/pinai/plugins/telegram-api-proxy:/opt/pinai/plugins/litellm-vision-adapter:/opt/pinai/plugins/platform-hooks"
ENV PINAI_SYSTEM_GUIDANCE_PATH="/opt/pinai/platform-system-guidance.md"

EXPOSE 18789

CMD ["pinai-entrypoint.sh"]
