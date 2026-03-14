# ============================================================================
# Stage 1: Builder — compile native modules, then discard build toolchain
# ============================================================================
FROM node:22-slim AS builder
ARG AGENT_BROWSER_VERSION=0.18.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    cmake \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set registry https://registry.npmmirror.com \
    && for attempt in 1 2 3 4 5; do \
        npm install -g openclaw@2026.3.8 @googleworkspace/cli agent-browser@${AGENT_BROWSER_VERSION} && break; \
        echo "npm install failed on attempt ${attempt}, retrying..." >&2; \
        sleep $((attempt * 10)); \
        [ "$attempt" -eq 5 ] && exit 1; \
      done \
    && rm -f /usr/local/bin/gog \
    && rm -rf /usr/local/lib/node_modules/openclaw/skills/gog \
    && npm cache clean --force

# ============================================================================
# Stage 2: Runtime — minimal image with only what's needed to run
# ============================================================================
FROM node:22-slim

# Runtime-only apt deps: git (openclaw skills), curl (used by skills at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-compiled global node_modules and binaries from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin

# Install Playwright browsers in runtime stage (--with-deps pulls apt libs)
ARG AGENT_BROWSER_VERSION=0.18.0
RUN mkdir -p /app/cache/ms-playwright \
    && for attempt in 1 2 3; do \
        PW_VERSION="$(node -p "require('/usr/local/lib/node_modules/agent-browser/node_modules/playwright-core/package.json').version")" \
        && PLAYWRIGHT_BROWSERS_PATH=/app/cache/ms-playwright npx -y "playwright@${PW_VERSION}" install --with-deps chromium chromium-headless-shell \
        && exit 0; \
        echo "playwright install failed on attempt ${attempt}, retrying..." >&2; \
        sleep $((attempt * 10)); \
      done; \
      exit 1

WORKDIR /app

# Unify ~/.openclaw → /app/.openclaw so that shell ~ (HOME=/root) and
# OpenClaw's CONFIG_DIR (OPENCLAW_HOME=/app) resolve to the same place.
RUN mkdir -p /app/.openclaw && ln -sfn /app/.openclaw /root/.openclaw

# Copy plugins
COPY pinai-openclaw/plugins/telegram-api-proxy/  /opt/pinai/plugins/telegram-api-proxy/
COPY pinai-openclaw/plugins/litellm-vision-adapter/ /opt/pinai/plugins/litellm-vision-adapter/
COPY pinai-openclaw/plugins/platform-hooks/      /opt/pinai/plugins/platform-hooks/

# Copy custom skills
COPY pinai-openclaw/image/skills/ /opt/pinai/skills/

# ── Warm up jiti + Node compile caches at build time ──
# Launch gateway with a near-production config so V8 compiles bytecode for
# the full module graph (channels, models, tools, skills, browser, cron).
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
ENV PLAYWRIGHT_BROWSERS_PATH="/app/cache/ms-playwright"

EXPOSE 18789

CMD ["pinai-entrypoint.sh"]
