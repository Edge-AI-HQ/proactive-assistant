# ============================================================================
# Stage 1: Builder — compile native modules, then discard build toolchain
# ============================================================================
FROM node:22-slim AS builder

# npm registry: default = npmjs.org (best for US/EU/CI/Fly remote builders).
# For mainland China: --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# or `export NPM_REGISTRY=...` (docker-compose picks it up).
ARG NPM_REGISTRY=https://registry.npmjs.org

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    python3 \
    cmake \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# fetch-timeout bounds each HTTP request; `timeout 900` bounds each full install
# attempt so a dead TCP socket can't hang a single try past 15 min.
RUN npm config set fetch-retries 5 \
    && npm config set fetch-retry-mintimeout 20000 \
    && npm config set fetch-retry-maxtimeout 120000 \
    && npm config set fetch-timeout 300000 \
    && npm config set registry ${NPM_REGISTRY} \
    && for attempt in 1 2 3 4 5; do \
        timeout 900 npm install -g openclaw@2026.4.5 @googleworkspace/cli && break; \
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

# ARG scope ends at FROM; redeclare so this stage's npm install can use it too.
ARG NPM_REGISTRY=https://registry.npmjs.org

# Runtime-only apt deps: git (openclaw skills), curl (used by skills at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    python3 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-compiled global node_modules and binaries from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin /usr/local/bin

WORKDIR /app

# Unify ~/.openclaw → /app/.openclaw so that shell ~ (HOME=/root) and
# OpenClaw's CONFIG_DIR (OPENCLAW_HOME=/app) resolve to the same place.
RUN mkdir -p /app/.openclaw && ln -sfn /app/.openclaw /root/.openclaw

# ── Plugin dependency layer (cached unless package.json changes) ──
# Copy only package manifests first so npm install is cached across plugin code changes.
COPY pinai-openclaw/plugins/proactive-ai/package.json /opt/pinai/plugins/proactive-ai/package.json
COPY pinai-openclaw/plugins/proactive-ai/package-lock.json /opt/pinai/plugins/proactive-ai/package-lock.json

# Install runtime npm deps for proactive-ai plugin (native modules)
# better-sqlite3 needs build tools — install in runtime since builder
# COPY doesn't cover plugin node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
    && cd /opt/pinai/plugins/proactive-ai \
    && timeout 900 npm ci --omit=dev --registry=${NPM_REGISTRY} \
    && apt-get purge -y build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# ── Warmup layer (cached unless openclaw version or deps change) ──
# Copy non-frequently-changing plugins + warmup config first.
COPY pinai-openclaw/plugins/platform-hooks/      /opt/pinai/plugins/platform-hooks/
COPY pinai-openclaw/image/skills/ /opt/pinai/skills/
COPY pinai-openclaw/image/warmup-config.json /tmp/warmup-config.json

# Warm up jiti + Node compile caches at build time.
# Launch gateway with a near-production config so V8 compiles bytecode for
# the full module graph (channels, models, tools, skills, browser, cron).
# NOTE: proactive-ai plugin source isn't copied yet — warmup caches the
# OpenClaw core + other plugins. proactive-ai's jiti cache is built on
# first container start and persisted on the volume.
RUN mkdir -p /tmp/jiti /app/.openclaw \
    && cp /tmp/warmup-config.json /app/.openclaw/openclaw.json \
    && OPENCLAW_HOME=/app \
       NODE_COMPILE_CACHE=/tmp/node-compile-cache \
       OPENCLAW_PLUGIN_LOAD_PATHS=/opt/pinai/plugins/platform-hooks \
       timeout 120 openclaw gateway --bind loopback 2>&1 || true \
    && mkdir -p /opt/pinai/jiti-warmup /opt/pinai/node-compile-warmup \
    && cp -r /tmp/jiti/. /opt/pinai/jiti-warmup/ 2>/dev/null || true \
    && cp -r /tmp/node-compile-cache/. /opt/pinai/node-compile-warmup/ 2>/dev/null || true \
    && rm -rf /tmp/jiti /tmp/node-compile-cache /app/.openclaw /tmp/warmup-config.json

# ── Plugin source layer (changes frequently — at the end) ──
COPY pinai-openclaw/plugins/proactive-ai/        /opt/pinai/plugins/proactive-ai/

# Guard against host-native node_modules overwriting the Linux build output.
RUN python3 - <<'PY'
from pathlib import Path

native = Path("/opt/pinai/plugins/proactive-ai/node_modules/better-sqlite3/build/Release/better_sqlite3.node")
if not native.exists():
    raise SystemExit(f"Missing required native module: {native}")

magic = native.read_bytes()[:4].hex()
if magic != "7f454c46":
    raise SystemExit(
        f"Expected Linux ELF better-sqlite3 binary, found magic={magic} at {native}"
    )
PY

# Build the `pin` CLI — esbuild bundles TS into a single executable JS file.
# Output lives next to the plugin's node_modules so external native deps
# (better-sqlite3, @lancedb/lancedb) resolve naturally via Node's algorithm.
# A thin symlink on PATH makes it callable as `pin` from anywhere.
RUN npx esbuild /opt/pinai/plugins/proactive-ai/cli/bin.ts \
      --bundle --platform=node --format=esm \
      --external:better-sqlite3 --external:@lancedb/lancedb \
      --banner:js='#!/usr/bin/env node' \
      --outfile=/opt/pinai/plugins/proactive-ai/pin.mjs \
    && chmod +x /opt/pinai/plugins/proactive-ai/pin.mjs \
    && ln -s /opt/pinai/plugins/proactive-ai/pin.mjs /usr/local/bin/pin

COPY pinai-openclaw/image/scripts/ /opt/pinai/scripts/
COPY pinai-openclaw/image/pinai-entrypoint.sh /usr/local/bin/pinai-entrypoint.sh
RUN chmod +x /usr/local/bin/pinai-entrypoint.sh
COPY pinai-openclaw/image/platform-system-guidance.md /opt/pinai/platform-system-guidance.md

ENV OPENCLAW_HOME="/app"
ENV OPENCLAW_MODE="headless"
ENV OPENCLAW_GATEWAY_PORT="18789"
ENV OPENCLAW_PLUGIN_LOAD_PATHS="/opt/pinai/plugins/platform-hooks:/opt/pinai/plugins/proactive-ai"
ENV PINAI_SYSTEM_GUIDANCE_PATH="/opt/pinai/platform-system-guidance.md"
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"

EXPOSE 18789

CMD ["pinai-entrypoint.sh"]
